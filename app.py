from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from datetime import datetime, date, time, timedelta
import requests
import pytz
import os
from functools import wraps
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY")

if not app.secret_key:
    raise ValueError("SECRET_KEY environment variable is required!")

# Configuration
API_BASE = os.getenv("API_BASE")
# Reply to Clients - for sending text messages from dashboard
MAKE_WEBHOOK_URL = os.getenv("MAKE_WEBHOOK_URL")
# Send File - for sending files from dashboard
MAKE_FILE_WEBHOOK_URL = os.getenv("MAKE_FILE_WEBHOOK_URL")
# WhatsApp Webhook - for chatbot (OpenAI) incoming messages
WHATSAPP_CHATBOT_WEBHOOK = os.getenv("WHATSAPP_CHATBOT_WEBHOOK")
DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD")

# Define IST timezone
IST = pytz.timezone('Asia/Kolkata')

def convert_to_ist(timestamp_str: str) -> datetime:
    """Convert ISO timestamp string to IST datetime object"""
    try:
        if not timestamp_str:
            return datetime.now(IST)
        timestamp_str = str(timestamp_str).replace('Z', '+00:00')
        try:
            dt = datetime.fromisoformat(timestamp_str)
        except:
            dt = datetime.strptime(timestamp_str, "%Y-%m-%dT%H:%M:%S.%f%z")
        if dt.tzinfo is None:
            dt = pytz.utc.localize(dt)
        ist_dt = dt.astimezone(IST)
        return ist_dt
    except Exception:
        return datetime.now(IST)

def format_timestamp_ist(timestamp) -> str:
    """Format timestamp to IST ISO string for frontend"""
    if isinstance(timestamp, str):
        dt = convert_to_ist(timestamp)
    elif isinstance(timestamp, datetime):
        if timestamp.tzinfo is None:
            dt = IST.localize(timestamp)
        else:
            dt = timestamp.astimezone(IST)
    else:
        dt = datetime.now(IST)
    return dt.isoformat()

def is_session_active(phone: str) -> bool:
    """
    Ask backend if WhatsApp 24h session is active for this phone
    """
    try:
        r = requests.get(f"{API_BASE}/session/{phone}", timeout=10)
        if not r.ok:
            return False
        return bool(r.json().get("session_active", False))
    except Exception as e:
        print("⚠️ Session check failed:", e)
        return False

# Debug: Print configuration on startup
print("=" * 50)
print("🚀 Flask App Configuration")
print("=" * 50)
print(f"API_BASE: {API_BASE}")
print(f"MAKE_WEBHOOK_URL (Reply to Clients): {MAKE_WEBHOOK_URL[:50]}..." if MAKE_WEBHOOK_URL else "MAKE_WEBHOOK_URL: NOT SET")
print(f"MAKE_FILE_WEBHOOK_URL (Send File): {MAKE_FILE_WEBHOOK_URL[:50]}..." if MAKE_FILE_WEBHOOK_URL else "MAKE_FILE_WEBHOOK_URL: NOT SET")
print(f"WHATSAPP_CHATBOT_WEBHOOK (Chatbot): {WHATSAPP_CHATBOT_WEBHOOK[:50]}..." if WHATSAPP_CHATBOT_WEBHOOK else "WHATSAPP_CHATBOT_WEBHOOK: NOT SET")
print(f"DASHBOARD_PASSWORD: {'SET' if DASHBOARD_PASSWORD else 'NOT SET'}")
print("=" * 50)

# Password protection decorator
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        password = request.form.get('password')
        if password == DASHBOARD_PASSWORD:
            session['logged_in'] = True
            return redirect(url_for('index'))
        return render_template('login.html', error="Wrong password")
    return render_template('login.html')

@app.route("/api/contacts", methods=["POST"])
@login_required
def create_contact_proxy():
    r = requests.post(
        f"{API_BASE}/contacts",
        json=request.json,
        timeout=10
    )
    return (r.text, r.status_code, r.headers.items())

@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('login'))

@app.route('/')
@login_required
def index():
    theme = session.get('theme', 'dark')
    return render_template('index.html', theme=theme)

@app.route('/api/toggle_theme', methods=['POST'])
@login_required
def toggle_theme():
    current_theme = session.get('theme', 'dark')
    new_theme = 'light' if current_theme == 'dark' else 'dark'
    session['theme'] = new_theme
    return jsonify({'theme': new_theme})

# API proxy endpoints
@app.route('/api/contacts')
@login_required
def get_contacts():
    only_follow_up = request.args.get('only_follow_up', 'false').lower() == 'true'
    filter_date = request.args.get('filter_date', None)
    
    try:
        response = requests.get(
            f"{API_BASE}/contacts",
            params={"only_follow_up": only_follow_up},
            timeout=30
        )
        contacts = response.json()
        
        # Convert all timestamps to IST
        for contact in contacts:
            if 'last_time' in contact:
                contact['last_time'] = format_timestamp_ist(contact['last_time'])
        
        # If date filter is applied, we need to check each contact's messages
        if filter_date:
            filtered_contacts = []
            for contact in contacts:
                # Fetch a sample of messages for this contact to check dates
                try:
                    msg_response = requests.get(
                        f"{API_BASE}/conversation/{contact['phone']}",
                        params={"limit": 100, "offset": 0},  # Get enough messages to check
                        timeout=10
                    )
                    messages = msg_response.json()
                    
                    # Check if any message matches the filter date
                    has_message_on_date = False
                    for msg in messages:
                        msg_date = convert_to_ist(msg['timestamp']).date()
                        filter_date_obj = datetime.fromisoformat(filter_date).date()
                        
                        if msg_date == filter_date_obj:
                            has_message_on_date = True
                            break
                    
                    if has_message_on_date:
                        filtered_contacts.append(contact)
                        
                except Exception as e:
                    print(f"Error checking messages for {contact['phone']}: {e}")
                    # If error, include contact to be safe
                    filtered_contacts.append(contact)
            
            return jsonify(filtered_contacts)
        
        return jsonify(contacts)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/conversation/<phone>')
@login_required
def get_conversation(phone):
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)

    try:
        # 1️⃣ Fetch messages from backend
        response = requests.get(
            f"{API_BASE}/conversation/{phone}",
            params={"limit": limit, "offset": offset},
            timeout=30
        )
        messages = response.json()

        # 2️⃣ Convert timestamps to IST
        for msg in messages:
            if 'timestamp' in msg:
                msg['timestamp'] = format_timestamp_ist(msg['timestamp'])

        # 3️⃣ Compute session status HERE (single source of truth)
        session_active = is_session_active(phone)

        # 4️⃣ Return combined response
        return jsonify({
            "messages": messages,
            "session_active": session_active
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/conversation/<phone>', methods=['DELETE'])
@login_required
def delete_conversation(phone):
    try:
        response = requests.delete(f"{API_BASE}/conversation/{phone}", timeout=30)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/message/<int:msg_id>', methods=['DELETE'])
@login_required
def delete_message(msg_id):
    try:
        response = requests.delete(f"{API_BASE}/message/{msg_id}", timeout=30)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/message/<int:msg_id>', methods=['PATCH'])
@login_required
def update_message(msg_id):
    try:
        data = request.json
        response = requests.patch(
            f"{API_BASE}/message/{msg_id}",
            json=data,
            timeout=30
        )
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/automation/<phone>')
@login_required
def get_automation(phone):
    try:
        response = requests.get(f"{API_BASE}/automation/{phone}", timeout=30)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/automation/<phone>', methods=['PATCH'])
@login_required
def set_automation(phone):
    try:
        data = request.json
        response = requests.patch(
            f"{API_BASE}/automation/{phone}",
            json=data,
            timeout=30
        )
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

from flask import request, jsonify
from datetime import datetime
import requests
import traceback

@app.route("/api/session/<phone>")
@login_required
def check_session(phone):
    try:
        r = requests.get(f"{API_BASE}/session/{phone}", timeout=10)
        if not r.ok:
            return jsonify({"session_active": False})

        return jsonify({
            "session_active": bool(r.json().get("session_active", False))
        })
    except Exception as e:
        print("⚠️ Session proxy failed:", e)
        return jsonify({"session_active": False})


@app.route('/api/send_message', methods=['POST'])
@login_required
def send_message():
    # 1. Configuration Check
    if not MAKE_WEBHOOK_URL:
        return jsonify({"error": "MAKE_WEBHOOK_URL not configured"}), 500
    
    try:
        data = request.get_json()
        phone = data.get('phone')
        message = data.get('message')

        # 2. Validation
        if not phone or not message:
            return jsonify({"error": "Phone and message are required"}), 400
        
        # 3. Session Check
        if not is_session_active(phone):
            return jsonify({
                "requires_template": True,
                "session_active": False
            }), 200
        
        print(f"\n{'='*60}\n📤 Dashboard user sending message to {phone}\n{'='*60}")
        
        # 4. External Webhook Call (Make.com)
        # We check the status code here to ensure the message actually queued
        response = requests.post(MAKE_WEBHOOK_URL, json=data, timeout=30)
        
        if response.status_code not in [200, 201, 202]:
            print(f"❌ Make.com Webhook failed: {response.status_code}")
            return jsonify({"error": "Failed to trigger WhatsApp webhook"}), 502

        # 5. Database Logging
        # REFACTORING NOTE: Avoid calling your own API via requests.post(f"{API_BASE}/log_message")
        # Instead, import the logic from that route and call it as a function.
        # Below is your current approach corrected for structure:
        log_data = {
            "phone": phone,
            "message": message,
            "timestamp": datetime.now(IST).isoformat(),
            "direction": "Dashboard User",
            "follow_up_needed": False,
            "notes": "",
            "handled_by": "Dashboard User"
        }
        
        # Using a timeout is good practice
        log_response = requests.post(f"{API_BASE}/log_message", json=log_data, timeout=10)
        
        print(f"✅ Process Complete. Log Status: {log_response.status_code}")
        print(f"{'='*60}\n")
        
        return jsonify({"success": True, "message": "Message sent and logged successfully"})
        
    except requests.exceptions.Timeout:
        return jsonify({"error": "Request timed out"}), 504
    except Exception as e:
        print(f"\n❌ Error in send_message: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": "An internal error occurred"}), 500
    
@app.route('/api/send_template', methods=['POST'])
@login_required
def send_template():
    if not MAKE_WEBHOOK_URL:
        return jsonify({"error": "Template webhook not configured"}), 500

    data = request.get_json()
    phone = data.get("phone")
    variables = data.get("variables")
    client_name = data.get("client_name", "Client")

    if not phone or not variables:
        return jsonify({"error": "Phone and variables required"}), 400

    # 1️⃣ Trigger Make template webhook
    r = requests.post(
        MAKE_WEBHOOK_URL,
        json={
            "phone": phone,
            "client_name": client_name,
            "variables": variables
        },
        timeout=20
    )

    if not r.ok:
        return jsonify({"error": "Template webhook failed"}), 502

    # 2️⃣ LOG TEMPLATE MESSAGE TO BACKEND (CRITICAL)
    try:
        requests.post(
            f"{API_BASE}/api/log_template_message",
            json={
                "phone": phone,
                "client_name": client_name,
                "message": variables,
            },
            timeout=10
        )
    except Exception as e:
        print("⚠️ Template logged failed:", e)

    return jsonify({"success": True})

    
@app.route("/api/contacts/<phone>", methods=["PATCH"])
def update_contact_proxy(phone):
    display_name = request.args.get("display_name")

    if not display_name:
        return {"error": "display_name required"}, 400

    r = requests.patch(
        f"{API_BASE}/contacts/{phone}",
        params={"display_name": display_name}
    )

    return (r.text, r.status_code, r.headers.items())


@app.route('/api/send_file', methods=['POST'])
@login_required
def send_file():
    if not MAKE_FILE_WEBHOOK_URL:
        return jsonify({"error": "MAKE_FILE_WEBHOOK_URL not configured"}), 500

    try:
        # ✅ Read multipart/form-data (NOT JSON)
        phone = request.form.get('phone')
        file = request.files.get('file')

        if not phone:
            return jsonify({"error": "Missing phone"}), 400

        if not file:
            return jsonify({"error": "No file received"}), 400

        print("\n" + "=" * 60)
        print("📎 Dashboard user sending file (RAW)")
        print("=" * 60)
        print(f"Phone: {phone}")
        print(f"Filename: {file.filename}")
        print(f"Mimetype: {file.mimetype}")
        print("=" * 60)

        # ✅ Forward RAW file to Make (multipart upload)
        files = {
            "file": (file.filename, file.stream, file.mimetype)
        }

        data = {
            "phone": phone,
            "type": "document"
        }

        response = requests.post(
            MAKE_FILE_WEBHOOK_URL,
            files=files,
            data=data,
            timeout=60
        )

        if not response.ok:
            print("❌ Make webhook failed:", response.text[:200])
            return jsonify({"error": "Make webhook failed"}), 500

        # ✅ LOG FILE MESSAGE TO BACKEND DB (so dashboard can show it)
        try:
            requests.post(
                f"{API_BASE}/log_message",
                json={
                    "phone": phone,
                    "message": f"📎 {file.filename}",
                    "timestamp": datetime.now(IST).isoformat(),
                    "direction": "Dashboard User",
                    "follow_up_needed": False,
                    "notes": f"File sent ({file.mimetype})",
                    "handled_by": "Dashboard User"
                },
                timeout=30
            )
        except Exception as log_err:
            # Logging failure should NOT block file delivery
            print("⚠️ Failed to log file message:", log_err)

        return jsonify({"success": True})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/api/alerts')
@login_required
def get_all_alerts():
    try:
        response = requests.get(f"{API_BASE}/alerts", timeout=10)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/alerts/<phone>', methods=['GET'])
@login_required
def get_alert(phone):
    try:
        response = requests.get(f"{API_BASE}/alerts/{phone}", timeout=10)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/alerts/<phone>', methods=['POST'])
@login_required
def set_alert(phone):
    try:
        data = request.json
        response = requests.post(
            f"{API_BASE}/alerts/{phone}",
            params={"has_alert": data.get('has_alert', True)},
            timeout=10
        )
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/alerts/<phone>', methods=['DELETE'])
@login_required
def delete_alert(phone):
    try:
        response = requests.delete(f"{API_BASE}/alerts/{phone}", timeout=10)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
