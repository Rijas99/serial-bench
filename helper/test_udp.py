import http.client
import json
import socket
import threading
import time
import unittest

import bench_helper as helper


class UdpTests(unittest.TestCase):
    def setUp(self):
        self.server = helper.HelperServer(port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.device = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.device.bind(("127.0.0.1", 0))
        self.device.settimeout(2)
        self.device_port = self.device.getsockname()[1]

    def tearDown(self):
        self.device.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def post(self, path, data, authorized=True):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        headers = {"Origin": helper.SITE_ORIGIN, "Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = "Bearer " + self.server.token
        connection.request("POST", "/udp/" + path, json.dumps(data), headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def open(self, **overrides):
        body = {"ip": "127.0.0.1", "remotePort": self.device_port, "localPort": 0}
        body.update(overrides)
        status, result = self.post("open", body)
        self.assertEqual(status, 200, result)
        return result

    def wait_rx(self, session, count=1):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status, result = self.post("read", {"session": session})
            self.assertEqual(status, 200)
            if result["received"] >= count:
                return result
            time.sleep(0.02)
        self.fail("UDP message was not received")

    def test_real_text_command_and_reply_use_same_receive_port(self):
        opened = self.open()
        status, result = self.post("send", {"session": opened["session"], "data": "STATUS", "ending": "crlf"})
        self.assertEqual(status, 200, result)
        command, sender = self.device.recvfrom(65535)
        self.assertEqual(command, b"STATUS\r\n")
        self.assertEqual(sender[1], opened["localPort"])
        self.device.sendto(b"OK\n", sender)
        result = self.wait_rx(opened["session"])
        self.assertEqual(result["sent"], 1)
        self.assertEqual([event["kind"] for event in result["events"]], ["tx", "rx"])
        self.assertEqual(result["events"][-1]["text"], "OK\n")

    def test_unsolicited_messages_arrive_before_any_send(self):
        opened = self.open()
        self.device.sendto(b"sensor=42", ("127.0.0.1", opened["localPort"]))
        result = self.wait_rx(opened["session"])
        self.assertEqual(result["sent"], 0)
        self.assertEqual(result["events"][0]["text"], "sensor=42")

    def test_hex_send_and_binary_receive(self):
        opened = self.open()
        status, _ = self.post("send", {"session": opened["session"], "data": "00 FF 0A", "encoding": "hex", "ending": "crlf"})
        self.assertEqual(status, 200)
        data, sender = self.device.recvfrom(65535)
        self.assertEqual(data, b"\x00\xff\x0a")
        self.device.sendto(b"\x00\xff", sender)
        result = self.wait_rx(opened["session"])
        self.assertEqual(result["events"][-1]["hex"], "00 FF")

    def test_rejects_nonlocal_ip_bad_ports_and_bad_sessions(self):
        for changes in [{"ip": "8.8.8.8"}, {"ip": "localhost"}, {"remotePort": 0}, {"remotePort": "1234"}, {"remotePort": True}, {"localPort": -1}, {"localPort": 65536}]:
            body = {"ip": "127.0.0.1", "remotePort": self.device_port, "localPort": 0, **changes}
            self.assertEqual(self.post("open", body)[0], 400, changes)
        self.assertEqual(self.post("read", {"session": "wrong"})[0], 400)

    def test_all_udp_endpoints_require_pairing(self):
        for endpoint in ["open", "read", "send", "close"]:
            self.assertEqual(self.post(endpoint, {}, authorized=False)[0], 403)

    def test_malformed_commands_and_cursor_do_not_send(self):
        opened = self.open()
        for body in [{"data": "F", "encoding": "hex"}, {"data": "ZZ", "encoding": "hex"}, {"data": []}, {"data": ""}, {"data": "a" * 4097}, {"data": "OK", "ending": {}}, {"data": "OK", "after": -1}]:
            self.assertEqual(self.post("send", {"session": opened["session"], **body})[0], 400, body)
        self.assertEqual(self.post("read", {"session": opened["session"]})[1]["sent"], 0)

    def test_fixed_port_busy_error_and_close(self):
        self.assertEqual(self.post("open", {"ip": "127.0.0.1", "remotePort": self.device_port, "localPort": self.device_port})[0], 400)
        opened = self.open()
        status, result = self.post("close", {"session": opened["session"]})
        self.assertEqual(status, 200)
        self.assertTrue(result["closed"])
        self.assertEqual(self.post("send", {"session": opened["session"], "data": "OK"})[0], 400)

    def test_receive_filter_ignores_other_device_ips(self):
        opened = self.open()
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as other:
            try:
                other.bind(("127.0.0.2", 0))
            except OSError:
                self.skipTest("OS does not support a second loopback source")
            other.sendto(b"wrong device", ("127.0.0.1", opened["localPort"]))
            self.device.sendto(b"right device", ("127.0.0.1", opened["localPort"]))
            result = self.wait_rx(opened["session"])
            self.assertEqual([event["text"] for event in result["events"]], ["right device"])

    def test_large_and_empty_datagrams_are_reported(self):
        opened = self.open()
        self.device.sendto(b"x" * 5000, ("127.0.0.1", opened["localPort"]))
        self.device.sendto(b"", ("127.0.0.1", opened["localPort"]))
        result = self.wait_rx(opened["session"], 2)
        first, second = result["events"]
        self.assertEqual(first["bytes"], 5000)
        self.assertEqual(len(first["text"]), 4096)
        self.assertTrue(first["truncated"])
        self.assertEqual(second["bytes"], 0)

    def test_bounded_ring_and_cursor(self):
        opened = self.open()
        session = self.server.udp.get(opened["session"])
        for index in range(250):
            session.record("rx", str(index).encode(), "127.0.0.1", self.device_port)
        result = self.post("read", {"session": opened["session"]})[1]
        self.assertEqual(result["skipped"], 50)
        self.assertEqual(len(result["events"]), 100)
        after = result["cursor"]
        newer = self.post("read", {"session": opened["session"], "after": after})[1]
        self.assertTrue(all(event["seq"] > after for event in newer["events"]))

    def test_session_limit_and_idle_expiry(self):
        opened = [self.open() for _ in range(4)]
        self.assertEqual(self.post("open", {"ip": "127.0.0.1", "remotePort": self.device_port})[0], 400)
        session = self.server.udp.get(opened[0]["session"])
        session.last_seen = time.monotonic() - 121
        session.thread.join(timeout=1)
        self.assertTrue(session.closed)
        self.assertIn("expired", session.error)
        self.open()


if __name__ == "__main__":
    unittest.main()
