import http.client
import json
import threading
import unittest
from unittest.mock import patch

import bench_helper as helper


class ValidationTests(unittest.TestCase):
    def test_local_addresses(self):
        for address in ["192.168.1.20", "10.0.0.1", "172.16.1.2", "172.31.255.1", "169.254.1.2", "127.0.0.1"]:
            with self.subTest(address=address):
                self.assertEqual(helper.validate_ip(address), address)

    def test_rejects_nonlocal_and_invalid_input(self):
        for address in ["8.8.8.8", "0.0.0.0", "255.255.255.255", "224.0.0.1", "172.32.0.1", "localhost", "::1", "192.168.01.1", "192.168.1.1 & calc", "256.1.1.1", {}, None]:
            with self.subTest(address=address):
                with self.assertRaises(ValueError):
                    helper.validate_ip(address)

    @unittest.skipUnless(helper.sys.platform == "win32", "Windows ICMP API")
    def test_real_windows_loopback_icmp(self):
        result = helper.ping_once("127.0.0.1")
        self.assertTrue(result["ok"], result)
        self.assertGreaterEqual(result["ms"], 0)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.server = helper.HelperServer(port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method="GET", path="/health", body=None, **headers):
        defaults = {"Origin": helper.SITE_ORIGIN}
        defaults.update(headers)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=defaults)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), json.loads(response.read())
        connection.close()
        return result

    def post(self, value, **headers):
        defaults = {"Content-Type": "application/json", "Authorization": "Bearer " + self.server.token}
        defaults.update(headers)
        return self.request("POST", "/ping", json.dumps(value), **defaults)

    def test_loopback_binding_and_unique_pairing_key(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(len(self.server.token), 43)
        second = helper.HelperServer(port=0)
        try:
            self.assertNotEqual(second.token, self.server.token)
        finally:
            second.server_close()

    def test_health_does_not_disclose_key(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.assertFalse(body["paired"])
        self.assertNotIn(self.server.token, json.dumps(body))
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_health_recognizes_pairing(self):
        self.assertTrue(self.request(Authorization="Bearer " + self.server.token)[2]["paired"])

    def test_rejects_untrusted_origins_and_rebinding(self):
        for headers in [{"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": "http://127.0.0.1:8765"}, {"Host": "evil.example"}]:
            with self.subTest(headers=headers):
                status, response_headers, _ = self.request(**headers)
                self.assertEqual(status, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)

    def test_preflight(self):
        status, headers, _ = self.request("OPTIONS", "/ping")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], helper.SITE_ORIGIN)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
        self.assertIn("Authorization", headers["Access-Control-Allow-Headers"])

    def test_ping_requires_key(self):
        for value in ["", "Bearer wrong", "Bearer \u00e9"]:
            self.assertEqual(self.post({"ip": "127.0.0.1"}, Authorization=value)[0], 403)

    def test_validation_prevents_ping(self):
        with patch.object(helper, "ping_once") as ping:
            for body in [{"ip": "8.8.8.8"}, {"ip": "127.0.0.1 & calc"}, [], None]:
                self.assertEqual(self.post(body)[0], 400)
            ping.assert_not_called()

    def test_malformed_and_oversized_requests(self):
        headers = {"Authorization": "Bearer " + self.server.token, "Content-Type": "application/json"}
        self.assertEqual(self.request("POST", "/ping", "{", **headers)[0], 400)
        self.assertEqual(self.request("POST", "/ping", " " * 257, **headers)[0], 400)
        self.assertEqual(self.post({"ip": "127.0.0.1"}, **{"Content-Type": "text/plain"})[0], 400)

    def test_result_and_rate_limit(self):
        with patch.object(helper, "ping_once", return_value={"ip": "127.0.0.1", "ok": True, "ms": 2}):
            status, _, body = self.post({"ip": "127.0.0.1"})
            self.assertEqual(status, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(self.post({"ip": "127.0.0.1"})[0], 429)

    def test_busy_helper(self):
        with self.server.ping_lock:
            self.assertEqual(self.post({"ip": "127.0.0.1"})[0], 429)

    def test_unknown_endpoint(self):
        self.assertEqual(self.request(path="/unknown")[0], 404)


if __name__ == "__main__":
    unittest.main()
