"""Per-user Windows setup shared by the helper and installer."""

import ctypes
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import winreg

APP_NAME = "HardwareCheckHelper"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
PROTOCOL_KEY = r"Software\Classes\hardwarecheck-helper"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\HardwareCheckHelper"


def app_directory():
    return Path(os.environ["LOCALAPPDATA"]) / "HardwareCheckHelper"


def pairing_token(directory=None):
    directory = Path(directory) if directory is not None else app_directory()
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / "pairing.key"
    try:
        value = file.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        value = secrets.token_urlsafe(32)
        try:
            with file.open("x", encoding="ascii") as stream:
                stream.write(value)
        except FileExistsError:
            value = file.read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
        raise ValueError("The pairing file is damaged. Run setup again after removing pairing.key.")
    return value


def set_value(key, name, value):
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as handle:
        winreg.SetValueEx(handle, name, 0, winreg.REG_SZ, value)


def configure_install(directory, start_with_windows=True):
    directory = Path(directory).resolve()
    executable = directory / "HardwareCheckHelper.exe"
    command = '"%s" --background' % executable
    if start_with_windows:
        set_value(RUN_KEY, APP_NAME, command)
    else:
        disable_startup()
    set_value(PROTOCOL_KEY, "", "URL:Hardware Check Helper")
    set_value(PROTOCOL_KEY, "URL Protocol", "")
    # Deliberately ignore the URI argument: only the fixed, trusted tester page can open.
    set_value(PROTOCOL_KEY + r"\shell\open\command", "", '"%s" --open-page' % executable)
    set_value(UNINSTALL_KEY, "DisplayName", "Hardware Check Helper")
    set_value(UNINSTALL_KEY, "DisplayVersion", "1.4.0")
    set_value(UNINSTALL_KEY, "Publisher", "Hardware Check / Rijas99")
    set_value(UNINSTALL_KEY, "InstallLocation", str(directory))
    set_value(UNINSTALL_KEY, "UninstallString", '"%s" --uninstall' % (directory / "Uninstall.exe"))


def disable_startup():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as handle:
            winreg.DeleteValue(handle, APP_NAME)
    except FileNotFoundError:
        pass


def delete_registry_tree(key):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_READ) as handle:
            children = []
            while True:
                try:
                    children.append(winreg.EnumKey(handle, len(children)))
                except OSError:
                    break
        for child in children:
            delete_registry_tree(key + "\\" + child)
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
    except FileNotFoundError:
        pass


def stop_event_name():
    identity = str(app_directory()).lower().encode("utf-8")
    return "Local\\HardwareCheckHelper-" + hashlib.sha256(identity).hexdigest()[:24]


def stop_installed_helper():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenEventW.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p]
    kernel.OpenEventW.restype = ctypes.c_void_p
    kernel.SetEvent.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenEventW(0x0002, False, stop_event_name())
    if handle:
        kernel.SetEvent(handle)
        kernel.CloseHandle(handle)
        time.sleep(0.5)


def install_files(source, installer, start_with_windows=True, directory=None):
    directory = Path(directory) if directory is not None else app_directory()
    directory.mkdir(parents=True, exist_ok=True)
    stop_installed_helper()
    for attempt in range(10):
        try:
            connection = socket.create_connection(("127.0.0.1", 47831), timeout=0.2)
        except OSError:
            break
        connection.close()
        if attempt == 9:
            raise OSError("Close the previous Hardware Check helper window, then click Install again.")
        time.sleep(0.2)
    for source_file, target_name in [(Path(source), "HardwareCheckHelper.exe"), (Path(installer), "Uninstall.exe")]:
        target = directory / target_name
        if source_file.resolve() != target.resolve():
            for attempt in range(20):
                try:
                    shutil.copy2(source_file, target)
                    break
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(0.2)
    pairing_token(directory)
    configure_install(directory, start_with_windows)
    return directory / "HardwareCheckHelper.exe"


def uninstall():
    directory = app_directory().resolve()
    # The deletion target is fixed to this user's named application directory.
    if directory.name != APP_NAME or directory.parent != Path(os.environ["LOCALAPPDATA"]).resolve():
        raise ValueError("Unexpected uninstall directory.")
    stop_installed_helper()
    disable_startup()
    delete_registry_tree(PROTOCOL_KEY)
    delete_registry_tree(UNINSTALL_KEY)
    # The uninstaller runs from a temporary copy, so it can remove all installed files.
    for attempt in range(30):
        try:
            shutil.rmtree(directory)
            return
        except FileNotFoundError:
            return
        except PermissionError:
            if attempt == 29:
                raise
            time.sleep(0.2)


def launch(executable, open_page=True):
    subprocess.Popen([str(executable), "--open-page" if open_page else "--background"],
                     creationflags=subprocess.CREATE_NO_WINDOW)
