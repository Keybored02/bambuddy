#!/usr/bin/env python3
"""MQTT Sniffer for Bambu Lab printers.

Connects to a printer, waits for the first MQTT payload on the report
topic, writes it to a file, then exits.

Usage:
    python mqtt_sniffer.py <printer_ip> <serial_number> <access_code> [output_file]

Example:
    python mqtt_sniffer.py 192.168.1.100 0948BB540200427 12345678 dump.json
"""

import json
import ssl
import sys

import paho.mqtt.client as mqtt


def on_connect(client, userdata, flags, rc):
    if rc != 0:
        print(f"Connection failed with code: {rc}")
        return
    print("Connected. Waiting for first payload...")
    topic = f"device/{userdata['serial']}/report"
    client.subscribe(topic)


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
        body = json.dumps(payload, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        body = msg.payload.decode("utf-8", errors="replace")

    with open(userdata["output_path"], "w", encoding="utf-8") as f:
        f.write(body)

    print(f"Saved payload from {msg.topic} -> {userdata['output_path']}")
    client.disconnect()


def main():
    if len(sys.argv) not in (4, 5):
        print("Usage: python mqtt_sniffer.py <printer_ip> <serial_number> <access_code> [output_file]")
        sys.exit(1)

    printer_ip = sys.argv[1]
    serial_number = sys.argv[2]
    access_code = sys.argv[3]
    output_path = sys.argv[4] if len(sys.argv) == 5 else "mqtt_dump.json"

    print(f"Connecting to {printer_ip} ({serial_number})...")

    client = mqtt.Client(userdata={"serial": serial_number, "output_path": output_path})
    client.username_pw_set("bblp", access_code)

    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    client.tls_set_context(ssl_context)

    client.on_connect = on_connect
    client.on_message = on_message

    client.connect(printer_ip, 8883, 60)
    client.loop_forever()


if __name__ == "__main__":
    main()
