"""One-time per-user installer. No administrator privileges required."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tkinter as tk
from tkinter import messagebox

import windows_setup


def main():
    root = tk.Tk()
    root.withdraw()
    if "--remove-installed-copy" in sys.argv:
        try:
            windows_setup.uninstall()
            messagebox.showinfo("Hardware Check", "The helper and automatic startup have been removed.")
        except OSError as error:
            messagebox.showerror("Uninstall failed", str(error))
        return
    if "--uninstall" in sys.argv:
        if not messagebox.askyesno("Uninstall Hardware Check", "Remove the helper, its pairing key, and automatic startup?"):
            return
        temporary = Path(tempfile.mkdtemp(prefix="hardware-check-uninstall-")) / "Uninstall.exe"
        shutil.copy2(sys.executable, temporary)
        subprocess.Popen([str(temporary), "--remove-installed-copy"], creationflags=subprocess.CREATE_NO_WINDOW)
        return
    root.deiconify()
    root.title("Hardware Check Helper Setup")
    root.geometry("480x310")
    root.resizable(False, False)
    frame = tk.Frame(root, padx=25, pady=24)
    frame.pack(fill="both", expand=True)
    tk.Label(frame, text="Set up this laptop once", font=("Segoe UI", 16, "bold")).pack(anchor="w")
    tk.Label(frame, text="Installs the helper for your Windows account.\nThe helper runs in the system tray near the clock.\nYour browser will still ask for local network permission.", justify="left", font=("Segoe UI", 10), pady=15).pack(anchor="w")
    startup = tk.BooleanVar(value=True)
    tk.Checkbutton(frame, text="Start automatically when I sign in to Windows", variable=startup).pack(anchor="w")
    status = tk.Label(frame, text="No administrator access required.", anchor="w", pady=10)
    status.pack(fill="x")

    def install():
        button.config(state="disabled")
        status.config(text="Installing…")
        root.update()
        try:
            source = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "HardwareCheckHelper.exe"
            executable = windows_setup.install_files(source, sys.executable, startup.get())
            windows_setup.launch(executable)
            messagebox.showinfo("Setup complete", "The helper is installed. The Network Ping page connects automatically.\n\nNext time, the helper starts automatically with Windows.\nYou can uninstall it from Windows Settings > Apps.")
            root.destroy()
        except (OSError, ValueError) as error:
            status.config(text="Setup did not finish.")
            messagebox.showerror("Setup failed", str(error))
            button.config(state="normal")

    button = tk.Button(frame, text="Install and open tester", command=install, padx=15, pady=7)
    button.pack(anchor="w")
    root.mainloop()


if __name__ == "__main__":
    main()
