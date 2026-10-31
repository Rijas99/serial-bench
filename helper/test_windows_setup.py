import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import windows_setup as setup


class SetupTests(unittest.TestCase):
    def test_pairing_survives_helper_restarts(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = setup.pairing_token(temporary)
            self.assertEqual(len(first), 43)
            self.assertEqual(setup.pairing_token(temporary), first)

    def test_damaged_key_is_not_used(self):
        with tempfile.TemporaryDirectory() as temporary:
            (Path(temporary) / "pairing.key").write_text("invalid")
            with self.assertRaises(ValueError):
                setup.pairing_token(temporary)

    def test_install_registration_uses_only_current_user_and_fixed_commands(self):
        with tempfile.TemporaryDirectory(prefix="helper with spaces ") as temporary:
            with patch.object(setup, "set_value") as write:
                setup.configure_install(temporary)
                values = {(args[0], args[1]): args[2] for args, _ in write.call_args_list}
                self.assertEqual(values[(setup.RUN_KEY, setup.APP_NAME)], '"%s" --background' % (Path(temporary).resolve() / "HardwareCheckHelper.exe"))
                command = values[(setup.PROTOCOL_KEY + r"\shell\open\command", "")]
                self.assertTrue(command.endswith('" --open-page'))
                self.assertNotIn("%1", command)
                self.assertIn("Uninstall.exe", values[(setup.UNINSTALL_KEY, "UninstallString")])

    def test_startup_can_be_disabled(self):
        with patch.object(setup, "set_value"), patch.object(setup, "disable_startup") as disable:
            setup.configure_install(Path(tempfile.gettempdir()) / "example", False)
            disable.assert_called_once()

    def test_install_copies_files_and_generates_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "payload.exe"
            installer = root / "setup.exe"
            source.write_bytes(b"test helper")
            installer.write_bytes(b"test installer")
            target = root / "install"
            with patch.object(setup, "stop_installed_helper"), patch.object(setup, "configure_install") as configure, patch.object(setup.socket, "create_connection", side_effect=ConnectionRefusedError):
                executable = setup.install_files(source, installer, directory=target)
            self.assertEqual(executable.read_bytes(), b"test helper")
            self.assertEqual((target / "Uninstall.exe").read_bytes(), b"test installer")
            self.assertTrue((target / "pairing.key").exists())
            configure.assert_called_once_with(target, True)

    def test_uninstall_only_removes_its_named_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"LOCALAPPDATA": temporary}):
                target = setup.app_directory()
                target.mkdir()
                (target / "test.txt").write_text("owned")
                neighbor = Path(temporary) / "keep.txt"
                neighbor.write_text("keep")
                with patch.object(setup, "stop_installed_helper"), patch.object(setup, "disable_startup") as disable, patch.object(setup, "delete_registry_tree") as delete:
                    setup.uninstall()
                self.assertFalse(target.exists())
                self.assertTrue(neighbor.exists())
                disable.assert_called_once()
                self.assertEqual(delete.call_count, 2)

    def test_stop_event_is_scoped_to_the_user_install_location(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": "C:/first-user"}):
            first = setup.stop_event_name()
        with patch.dict(os.environ, {"LOCALAPPDATA": "C:/other-user"}):
            second = setup.stop_event_name()
        self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
