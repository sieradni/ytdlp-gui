import os
import json
import subprocess
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import re


CONFIG_FILE = 'ytdlp_gui_config.json'

# Regular expression to parse yt-dlp progress
PROGRESS_PATTERN = re.compile(r'\[download\]\s+([0-9\.]+)%')


def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding = 'utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_config(config_data):
    with open(CONFIG_FILE, 'w', encoding = 'utf-8') as f:
        json.dump(config_data, f, indent = 4)


class YTDLPApp:
    def __init__(self, root):
        self.root = root
        self.root.title("yt-dlp Downloader")
        self.root.geometry("850x700")

        self.config = load_config()
        self.is_downloading = False

        # Create Tabbed layout
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill = 'both', expand = True, padx = 10, pady = 10)

        self.tab_downloads = ttk.Frame(self.notebook)
        self.tab_settings = ttk.Frame(self.notebook)

        self.notebook.add(self.tab_downloads, text = 'Downloads')
        self.notebook.add(self.tab_settings, text = 'Configuration')

        self.build_settings_tab()
        self.build_downloads_tab()

    def build_settings_tab(self):
        # yt-dlp Executable Path
        ttk.Label(self.tab_settings, text = "yt-dlp Executable:").grid(row = 0, column = 0,
                                                                       sticky = 'w', padx = 10,
                                                                       pady = (20, 5))
        self.path_ytdlp = tk.StringVar(value = self.config.get('ytdlp_path', ''))
        ttk.Entry(self.tab_settings, textvariable = self.path_ytdlp, width = 50).grid(row = 0,
                                                                                      column = 1,
                                                                                      padx = 5,
                                                                                      pady = (20,
                                                                                              5),
                                                                                      sticky = 'we')
        ttk.Button(self.tab_settings, text = "Browse",
                   command = lambda: self.browse_file(self.path_ytdlp)).grid(row = 0, column = 2,
                                                                             pady = (20, 5))

        # Output Directory
        ttk.Label(self.tab_settings, text = "Output Directory:").grid(row = 1, column = 0,
                                                                      sticky = 'w', padx = 10,
                                                                      pady = 5)
        self.path_output = tk.StringVar(
            value = self.config.get('output_dir', os.path.expanduser('~/Downloads')))
        ttk.Entry(self.tab_settings, textvariable = self.path_output, width = 50).grid(row = 1,
                                                                                       column = 1,
                                                                                       padx = 5,
                                                                                       pady = 5,
                                                                                       sticky = 'we')
        ttk.Button(self.tab_settings, text = "Browse",
                   command = lambda: self.browse_dir(self.path_output)).grid(row = 1, column = 2,
                                                                             pady = 5)

        # FFmpeg Directory
        ttk.Label(self.tab_settings, text = "FFmpeg Folder (Optional):").grid(row = 2, column = 0,
                                                                              sticky = 'w',
                                                                              padx = 10, pady = 5)
        self.path_ffmpeg = tk.StringVar(value = self.config.get('ffmpeg_path', ''))
        ttk.Entry(self.tab_settings, textvariable = self.path_ffmpeg, width = 50).grid(row = 2,
                                                                                       column = 1,
                                                                                       padx = 5,
                                                                                       pady = 5,
                                                                                       sticky = 'we')
        ttk.Button(self.tab_settings, text = "Browse",
                   command = lambda: self.browse_dir(self.path_ffmpeg)).grid(row = 2, column = 2,
                                                                             pady = 5)

        # Audio Codec
        ttk.Label(self.tab_settings, text = "Preferred Audio Codec:").grid(row = 3, column = 0,
                                                                           sticky = 'w', padx = 10,
                                                                           pady = 5)
        self.var_audio_codec = tk.StringVar(value = self.config.get('audio_codec', 'opus'))
        codecs = ['none (keep original)', 'mp3', 'm4a', 'opus', 'flac', 'vorbis', 'alac', 'mka', 'mp4']

        self.combo_codec = ttk.Combobox(self.tab_settings, textvariable = self.var_audio_codec,
                                        values = codecs, state = 'readonly', width = 20)
        self.combo_codec.grid(row = 3, column = 1, sticky = 'w', padx = 5, pady = 5)
        self.combo_codec.bind("<<ComboboxSelected>>", self.check_codec_warning)

        # Warning Label for Codecs (Placed on a new row with columnspan=3 to prevent breaking the layout)
        self.label_codec_warning = ttk.Label(self.tab_settings, text = "", foreground = "red")
        self.label_codec_warning.grid(row = 4, column = 0, columnspan = 3, sticky = 'w', padx = 10,
                                      pady = (0, 5))
        self.check_codec_warning()  # Initialize warning state

        # Download Archive Toggle
        self.var_use_archive = tk.BooleanVar(value = self.config.get('use_archive', True))
        ttk.Checkbutton(self.tab_settings,
                        text = "Enable Download Archive (Skip already downloaded)",
                        variable = self.var_use_archive).grid(row = 5, column = 1, sticky = 'w',
                                                              padx = 5, pady = 5)

        # Playlists Toggle
        self.var_dl_playlists = tk.BooleanVar(value = self.config.get('download_playlists', True))
        ttk.Checkbutton(self.tab_settings, text = "Download Playlists",
                        variable = self.var_dl_playlists,
                        command = self.toggle_playlist_limit).grid(row = 6, column = 1,
                                                                   sticky = 'w', padx = 5, pady = 5)

        # Playlist Limit
        ttk.Label(self.tab_settings, text = "Playlist Limit (0 = All):").grid(row = 7, column = 0,
                                                                              sticky = 'w',
                                                                              padx = 10, pady = 5)
        self.var_pl_limit = tk.StringVar(value = str(self.config.get('playlist_limit', 0)))
        self.entry_pl_limit = ttk.Entry(self.tab_settings, textvariable = self.var_pl_limit,
                                        width = 15)
        self.entry_pl_limit.grid(row = 7, column = 1, sticky = 'w', padx = 5, pady = 5)
        self.toggle_playlist_limit()

        # Save Button
        ttk.Button(self.tab_settings, text = "Save Configurations",
                   command = lambda: self.save_settings(show_msg = True)).grid(row = 8, column = 1,
                                                                               pady = 30,
                                                                               sticky = 'e')

    def check_codec_warning(self, event = None):
        codec = self.var_audio_codec.get()
        if codec == 'none (keep original)':
            self.label_codec_warning.config(
                text = "⚠️ Warning: WebM and some original formats often fail to embed thumbnails.")
        else:
            self.label_codec_warning.config(text = "")

    def toggle_playlist_limit(self):
        if self.var_dl_playlists.get():
            self.entry_pl_limit.config(state = 'normal')
        else:
            self.entry_pl_limit.config(state = 'disabled')

    def build_downloads_tab(self):
        # 1. Input Area (Top)
        frame_input = ttk.Frame(self.tab_downloads)
        frame_input.pack(fill = 'x', padx = 10, pady = 10)

        ttk.Label(frame_input, text = "Video URLs (one per line):").pack(anchor = 'w')

        # Packing the button RIGHT first ensures it won't be pushed out on low window sizes
        btn_start = tk.Button(frame_input, text = "Queue &\nStart", bg = "#4CAF50", fg = "white",
                              font = ('Arial', 10, 'bold'), command = self.queue_urls)
        btn_start.pack(side = 'right', padx = (10, 0), fill = 'y', pady = 5)

        self.url_input = tk.Text(frame_input, height = 4, width = 40)
        self.url_input.pack(side = 'left', fill = 'both', expand = True, pady = 5)

        # 2. Queue Section (Middle)
        frame_queue = ttk.Frame(self.tab_downloads)
        frame_queue.pack(fill = 'both', expand = True, padx = 10, pady = 5)

        # Queue Header with Remove Button
        frame_queue_header = ttk.Frame(frame_queue)
        frame_queue_header.pack(fill = 'x')
        ttk.Label(frame_queue_header, text = "Queued URLs:").pack(side = 'left', anchor = 'w')
        ttk.Button(frame_queue_header, text = "Remove Selected",
                   command = self.remove_selected).pack(side = 'right')

        # Treeview for columns
        frame_tree = ttk.Frame(frame_queue)
        frame_tree.pack(fill = 'both', expand = True, pady = (5, 0))

        columns = ("url", "status")
        self.queue_tree = ttk.Treeview(frame_tree, columns = columns, show = "headings", height = 6)
        self.queue_tree.heading("url", text = "URL")
        self.queue_tree.heading("status", text = "Status")
        self.queue_tree.column("url", width = 600)
        self.queue_tree.column("status", width = 120, anchor = 'center')

        # Bind delete key to remove logic
        self.queue_tree.bind("<Delete>", lambda e: self.remove_selected())

        scrollbar_queue = ttk.Scrollbar(frame_tree, orient = "vertical",
                                        command = self.queue_tree.yview)
        self.queue_tree.configure(yscrollcommand = scrollbar_queue.set)

        self.queue_tree.pack(side = 'left', fill = 'both', expand = True)
        scrollbar_queue.pack(side = 'right', fill = 'y')

        # Progress Bar section
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(self.tab_downloads, variable = self.progress_var,
                                            maximum = 100)
        self.progress_bar.pack(fill = 'x', padx = 10, pady = (5, 10))

        # 3. CMD Output Section (Bottom)
        frame_output = ttk.Frame(self.tab_downloads)
        frame_output.pack(fill = 'both', expand = True, padx = 10, pady = 5)

        ttk.Label(frame_output, text = "Command Output:").pack(anchor = 'w')

        self.cmd_output = tk.Text(frame_output, height = 12, bg = "black", fg = "white",
                                  font = ("Consolas", 9), state = 'disabled')
        scrollbar_out = ttk.Scrollbar(frame_output, orient = "vertical",
                                      command = self.cmd_output.yview)
        self.cmd_output.configure(yscrollcommand = scrollbar_out.set)

        self.cmd_output.pack(side = 'left', fill = 'both', expand = True)
        scrollbar_out.pack(side = 'right', fill = 'y')

    # --- UI ACTIONS ---
    def browse_file(self, string_var):
        filepath = filedialog.askopenfilename()
        if filepath:
            string_var.set(filepath)

    def browse_dir(self, string_var):
        dirpath = filedialog.askdirectory()
        if dirpath:
            string_var.set(dirpath)

    def save_settings(self, show_msg = False):
        self.config['ytdlp_path'] = self.path_ytdlp.get()
        self.config['output_dir'] = self.path_output.get()
        self.config['ffmpeg_path'] = self.path_ffmpeg.get()
        self.config['audio_codec'] = self.var_audio_codec.get()
        self.config['use_archive'] = self.var_use_archive.get()
        self.config['download_playlists'] = self.var_dl_playlists.get()

        try:
            self.config['playlist_limit'] = int(self.var_pl_limit.get())
        except ValueError:
            self.config['playlist_limit'] = 0

        save_config(self.config)

        if show_msg:
            messagebox.showinfo("Saved", "Configurations saved successfully!")

    def log_output(self, text):
        """Thread-safe way to update the command output textbox."""
        self.cmd_output.config(state = 'normal')
        self.cmd_output.insert(tk.END, text)
        self.cmd_output.see(tk.END)
        self.cmd_output.config(state = 'disabled')

    def update_tree_status(self, item_id, new_status):
        """Thread-safe way to update the queue status."""
        current_values = self.queue_tree.item(item_id, "values")
        self.queue_tree.item(item_id, values = (current_values[0], new_status))

    def update_progress(self, percentage):
        """Thread-safe way to update the progress bar."""
        self.progress_var.set(percentage)

    def remove_selected(self):
        """Remove items from the queue (unless currently downloading)"""
        selected_items = self.queue_tree.selection()
        for item in selected_items:
            status = self.queue_tree.item(item, "values")[1]
            if status != "Downloading...":
                self.queue_tree.delete(item)

    # --- DOWNLOAD LOGIC ---
    def queue_urls(self):
        # Save settings silently so changes apply
        self.save_settings(show_msg = False)

        if not self.config.get('ytdlp_path'):
            messagebox.showerror("Error",
                                 "Please select your yt-dlp executable in the Configuration tab.")
            return

        urls = self.url_input.get("1.0", tk.END).strip().split()
        if not urls:
            return

        # Move URLs from input field to the queue treeview
        self.url_input.delete("1.0", tk.END)
        for u in urls:
            self.queue_tree.insert("", tk.END, values = (u, "Queued"))

        # Start processing background thread if not already running
        if not self.is_downloading:
            self.is_downloading = True
            threading.Thread(target = self.process_queue, daemon = True).start()

    def process_queue(self):
        while True:
            # 1. Find the next "Queued" item
            items = self.queue_tree.get_children()
            target_item = None
            target_url = ""

            for item in items:
                if self.queue_tree.item(item, "values")[1] == "Queued":
                    target_item = item
                    target_url = self.queue_tree.item(item, "values")[0]
                    break

            if not target_item:
                break  # Everything is done

            # 2. Update status to downloading
            self.root.after(0, self.update_tree_status, target_item, "Downloading...")
            self.root.after(0, self.log_output, f"\n🚀 Starting: {target_url}\n")
            self.root.after(0, self.update_progress, 0.0)

            # 3. Construct command
            cmd = [
                self.config['ytdlp_path'],
                "--newline",
                "-f", "ba",
                "-x",
                "--embed-metadata",
                "--embed-thumbnail",
                "--ppa", "ThumbnailsConvertor+ffmpeg_o:-c:v png -vf crop='ih'",
                "--no-post-overwrites",
                "-P", self.config['output_dir']
            ]

            # Handle Audio Codec vs Remuxing
            codec = self.config.get('audio_codec', 'opus')
            if codec == 'mka':
                cmd.extend(["--remux-video", "mka"])
            elif codec == 'mp4':
                cmd.extend(["--remux-video", "mp4"])
            elif codec != 'none (keep original)':
                cmd.extend(["--audio-format", codec])

            # Append Archive if enabled
            if self.config.get('use_archive', True):
                archive_path = os.path.join(os.path.dirname(self.config['ytdlp_path']),
                                            "downloaded.txt")
                cmd.extend(["--download-archive", archive_path])

            # Append Playlist limits
            if self.config.get('download_playlists', True):
                limit = self.config.get('playlist_limit', 0)
                if limit > 0:
                    cmd.extend(["--playlist-end", str(limit)])
            else:
                cmd.append("--no-playlist")

            # Append FFmpeg
            if self.config.get('ffmpeg_path'):
                cmd.extend(["--ffmpeg-location", self.config['ffmpeg_path']])

            cmd.append(target_url)

            # 4. Run Subprocess
            try:
                process = subprocess.Popen(
                    cmd,
                    stdout = subprocess.PIPE,
                    stderr = subprocess.STDOUT,
                    text = True,
                    encoding = 'utf-8',
                    errors = 'replace',
                    bufsize = 1
                )

                for line in process.stdout:
                    # Log output
                    self.root.after(0, self.log_output, line)

                    # Parse output for progress percentage
                    match = PROGRESS_PATTERN.search(line)
                    if match:
                        try:
                            percentage = float(match.group(1))
                            self.root.after(0, self.update_progress, percentage)
                        except ValueError:
                            pass

                process.wait()

                # 5. Assess final result for this specific URL
                if process.returncode == 0:
                    self.root.after(0, self.update_tree_status, target_item, "✅ Done")
                else:
                    self.root.after(0, self.update_tree_status, target_item, "❌ Error")

            except Exception as e:
                self.root.after(0, self.log_output, f"System Error: {str(e)}\n")
                self.root.after(0, self.update_tree_status, target_item, "❌ Failed")

        # Finished all queued items
        self.root.after(0, self.update_progress, 0.0)
        self.root.after(0, self.log_output, "\n🎉 Queue Complete!\n")
        self.is_downloading = False


if __name__ == "__main__":
    root = tk.Tk()
    app = YTDLPApp(root)
    root.mainloop()