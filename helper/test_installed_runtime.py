"""Optional packaged-runtime test: set HELPER_EXE to the built executable."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.request

import windows_setup


@unittest.skipUnless(os.environ.get("HELPER_EXE"), "Set HELPER_EXE to test packaged tray mode")
class InstalledRuntimeTests(unittest.TestCase):
    def test_tray_start_stop_and_stable_pairing_without_changing_startup_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            environment = dict(os.environ, LOCALAPPDATA=temporary)
            token = windows_setup.pairing_token(Path(temporary) / "HardwareCheckHelper")
            for _ in range(2):
                process = subprocess.Popen([os.environ["HELPER_EXE"], "--background", "--no-browser"],
                                           env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           creationflags=subprocess.CREATE_NO_WINDOW)
                try:
                    body = None
                    for attempt in range(60):
                        if process.poll() is not None:
                            self.fail("Background helper exited before serving: " + process.stderr.read().decode(errors="replace"))
                        try:
                            request = urllib.request.Request("http://127.0.0.1:47831/health", headers={
                                "Origin": "https://rijas99.github.io", "Authorization": "Bearer " + token})
                            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=1) as response:
                                body = json.load(response)
                            break
                        except OSError:
                            time.sleep(0.1)
                    self.assertIsNotNone(body)
                    self.assertTrue(body["paired"])
                    # Wait for tray creation after the HTTP thread starts.
                    time.sleep(0.3)
                    with patch.dict(os.environ, {"LOCALAPPDATA": temporary}):
                        windows_setup.stop_installed_helper()
                    self.assertEqual(process.wait(timeout=10), 0)
                finally:
                    if process.poll() is None:
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                    process.stdout.close()
                    process.stderr.close()


if __name__ == "__main__":
    unittest.main()
