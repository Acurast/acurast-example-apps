import os
import platform

import requests

webhook = os.environ["WEBHOOK_URL"]
payload = {
    "language": "Python",
    "runtime": "Python " + platform.python_version(),
    "message": "Hello from Python running on Acurast!",
}

resp = requests.post(webhook, json=payload)
print("posted:", resp.status_code)
