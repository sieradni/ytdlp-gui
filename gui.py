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
        self.root.geometry("850x820")

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
        # 1. yt-dlp Executable Path
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

        # 2. Output Directory
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

        # 3. FFmpeg Directory
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

        # 4. Download Type (Audio vs Video)
        ttk.Label(self.tab_settings, text = "Download Type:").grid(row = 3, column = 0,
                                                                   sticky = 'w', padx = 10,
                                                                   pady = 5)
        self.var_format_type = tk.StringVar(value = self.config.get('format_type', 'Audio'))
        frame_type = ttk.Frame(self.tab_settings)
        frame_type.grid(row = 3, column = 1, sticky = 'w', padx = 5, pady = 5)
        ttk.Radiobutton(frame_type, text = "Audio", variable = self.var_format_type,
                        value = "Audio", command = self.toggle_format_settings).pack(side = 'left',
                                                                                     padx = (0, 15))
        ttk.Radiobutton(frame_type, text = "Video", variable = self.var_format_type,
                        value = "Video", command = self.toggle_format_settings).pack(side = 'left')

        # 5. Audio Codec (Audio Only)
        ttk.Label(self.tab_settings, text = "Preferred Audio Codec:").grid(row = 4, column = 0,
                                                                           sticky = 'w', padx = 10,
                                                                           pady = 5)
        self.var_audio_codec = tk.StringVar(value = self.config.get('audio_codec', 'opus'))
        codecs = ['none (keep original)', 'mp3', 'm4a', 'opus', 'flac', 'vorbis', 'alac', 'mka',
                  'mp4']
        self.combo_codec = ttk.Combobox(self.tab_settings, textvariable = self.var_audio_codec,
                                        values = codecs, state = 'readonly', width = 25)
        self.combo_codec.grid(row = 4, column = 1, sticky = 'w', padx = 5, pady = 5)
        self.combo_codec.bind("<<ComboboxSelected>>", self.check_codec_warning)

        # 6. Video Resolution
        ttk.Label(self.tab_settings, text = "Max Video Resolution:").grid(row = 5, column = 0,
                                                                          sticky = 'w', padx = 10,
                                                                          pady = 5)
        self.var_video_res = tk.StringVar(value = self.config.get('video_res', 'Best'))
        resolutions = ['Best', '4320p', '2160p', '1440p', '1080p', '720p', '480p', '360p']
        self.combo_video_res = ttk.Combobox(self.tab_settings, textvariable = self.var_video_res,
                                            values = resolutions, state = 'readonly', width = 25)
        self.combo_video_res.grid(row = 5, column = 1, sticky = 'w', padx = 5, pady = 5)

        # 7. Video Container Format
        ttk.Label(self.tab_settings, text = "Video Format:").grid(row = 6, column = 0, sticky = 'w',
                                                                  padx = 10, pady = 5)
        self.var_video_ext = tk.StringVar(value = self.config.get('video_ext', 'mp4'))
        self.combo_video_ext = ttk.Combobox(self.tab_settings, textvariable = self.var_video_ext,
                                            values = ['mp4', 'mkv', 'webm'], state = 'readonly',
                                            width = 25)
        self.combo_video_ext.grid(row = 6, column = 1, sticky = 'w', padx = 5, pady = 5)
        self.combo_video_ext.bind("<<ComboboxSelected>>", self.check_codec_warning)

        # 8. Video Audio Preference
        ttk.Label(self.tab_settings, text = "Video Audio Preference:").grid(row = 7, column = 0,
                                                                            sticky = 'w', padx = 10,
                                                                            pady = 5)
        self.var_video_audio = tk.StringVar(
            value = self.config.get('video_audio_pref', 'Best Audio (Default)'))
        audio_prefs = ['Best Audio (Default)', 'Highly Compatible (AAC/M4A)']
        self.combo_video_audio = ttk.Combobox(self.tab_settings,
                                              textvariable = self.var_video_audio,
                                              values = audio_prefs, state = 'readonly', width = 25)
        self.combo_video_audio.grid(row = 7, column = 1, sticky = 'w', padx = 5, pady = 5)
        self.combo_video_audio.bind("<<ComboboxSelected>>", self.check_codec_warning)

        # Warning Label for Codecs/Formats
        self.label_codec_warning = ttk.Label(self.tab_settings, text = "", foreground = "red",
                                             justify = 'left')
        self.label_codec_warning.grid(row = 8, column = 0, columnspan = 3, sticky = 'w', padx = 10,
                                      pady = (0, 5))

        # Initialize UI toggle states
        self.toggle_format_settings()

        # 9. Download Archive Toggle
        self.var_use_archive = tk.BooleanVar(value = self.config.get('use_archive', True))
        ttk.Checkbutton(self.tab_settings,
                        text = "Enable Download Archive (Skip already downloaded)",
                        variable = self.var_use_archive).grid(row = 9, column = 1, sticky = 'w',
                                                              padx = 5, pady = 5)

        # 10. Playlists Toggle
        self.var_dl_playlists = tk.BooleanVar(value = self.config.get('download_playlists', True))
        ttk.Checkbutton(self.tab_settings, text = "Download Playlists",
                        variable = self.var_dl_playlists,
                        command = self.toggle_playlist_limit).grid(row = 10, column = 1,
                                                                   sticky = 'w', padx = 5, pady = 5)

        # 11. Playlist Limit
        ttk.Label(self.tab_settings, text = "Playlist Limit (0 = All):").grid(row = 11, column = 0,
                                                                              sticky = 'w',
                                                                              padx = 10, pady = 5)
        self.var_pl_limit = tk.StringVar(value = str(self.config.get('playlist_limit', 0)))
        self.entry_pl_limit = ttk.Entry(self.tab_settings, textvariable = self.var_pl_limit,
                                        width = 15)
        self.entry_pl_limit.grid(row = 11, column = 1, sticky = 'w', padx = 5, pady = 5)
        self.toggle_playlist_limit()

        # 12. Save Button
        ttk.Button(self.tab_settings, text = "Save Configurations",
                   command = lambda: self.save_settings(show_msg = True)).grid(row = 12, column = 1,
                                                                               pady = 30,
                                                                               sticky = 'e')

    def toggle_format_settings(self, event = None):
        """Enables or disables combo boxes based on whether Audio or Video is selected"""
        if self.var_format_type.get() == "Audio":
            self.combo_codec.config(state = 'readonly')
            self.combo_video_res.config(state = 'disabled')
            self.combo_video_ext.config(state = 'disabled')
            self.combo_video_audio.config(state = 'disabled')
        else:
            self.combo_codec.config(state = 'disabled')
            self.combo_video_res.config(state = 'readonly')
            self.combo_video_ext.config(state = 'readonly')
            self.combo_video_audio.config(state = 'readonly')
        self.check_codec_warning()

    def check_codec_warning(self, event = None):
        warnings = []
        if self.var_format_type.get() == "Audio":
            if self.var_audio_codec.get() == 'none (keep original)':
                warnings.append("⚠️ WebM and some original formats often fail to embed thumbnails.")
        else:
            if self.var_video_ext.get() == 'webm':
                warnings.append("⚠️ WebM container does not support embedded thumbnails.")
            if self.var_video_audio.get() == 'Best Audio (Default)':
                warnings.append(
                    "ℹ️ 'Best Audio' may use Opus, which is unsupported on some devices/media players.\n.")

        self.label_codec_warning.config(text = "\n".join(warnings))

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

        btn_start = tk.Button(frame_input, text = "Queue &\nStart", bg = "#4CAF50", fg = "white",
                              font = ('Arial', 10, 'bold'), command = self.queue_urls)
        btn_start.pack(side = 'right', padx = (10, 0), fill = 'y', pady = 5)

        self.url_input = tk.Text(frame_input, height = 4, width = 40)
        self.url_input.pack(side = 'left', fill = 'both', expand = True, pady = 5)

        # 2. Queue Section (Middle)
        frame_queue = ttk.Frame(self.tab_downloads)
        frame_queue.pack(fill = 'both', expand = True, padx = 10, pady = 5)

        frame_queue_header = ttk.Frame(frame_queue)
        frame_queue_header.pack(fill = 'x')
        ttk.Label(frame_queue_header, text = "Queued URLs (Right-click to Copy):").pack(
            side = 'left', anchor = 'w')
        ttk.Button(frame_queue_header, text = "Remove Selected",
                   command = self.remove_selected).pack(side = 'right')

        frame_tree = ttk.Frame(frame_queue)
        frame_tree.pack(fill = 'both', expand = True, pady = (5, 0))

        columns = ("url", "status")
        self.queue_tree = ttk.Treeview(frame_tree, columns = columns, show = "headings", height = 6)
        self.queue_tree.heading("url", text = "URL")
        self.queue_tree.heading("status", text = "Status")
        self.queue_tree.column("url", width = 600)
        self.queue_tree.column("status", width = 120, anchor = 'center')

        # Bindings for Deleting & Copying
        self.queue_tree.bind("<Delete>", lambda e: self.remove_selected())
        self.queue_tree.bind("<Control-c>", self.copy_urls)
        self.queue_tree.bind("<Command-c>", self.copy_urls)  # For macOS

        # Context Menu
        self.queue_menu = tk.Menu(self.root, tearoff = 0)
        self.queue_menu.add_command(label = "Copy URL(s)", command = self.copy_urls)
        self.queue_menu.add_command(label = "Remove Selected", command = self.remove_selected)

        self.queue_tree.bind("<Button-3>", self.show_context_menu)  # Windows/Linux Right Click
        self.queue_tree.bind("<Button-2>", self.show_context_menu)  # MacOS Right Click

        scrollbar_queue = ttk.Scrollbar(frame_tree, orient = "vertical",
                                        command = self.queue_tree.yview)
        self.queue_tree.configure(yscrollcommand = scrollbar_queue.set)

        self.queue_tree.pack(side = 'left', fill = 'both', expand = True)
        scrollbar_queue.pack(side = 'right', fill = 'y')

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

        self.config['format_type'] = self.var_format_type.get()
        self.config['audio_codec'] = self.var_audio_codec.get()
        self.config['video_res'] = self.var_video_res.get()
        self.config['video_ext'] = self.var_video_ext.get()
        self.config['video_audio_pref'] = self.var_video_audio.get()

        self.config['use_archive'] = self.var_use_archive.get()
        self.config['download_playlists'] = self.var_dl_playlists.get()

        try:
            self.config['playlist_limit'] = int(self.var_pl_limit.get())
        except ValueError:
            self.config['playlist_limit'] = 0

        save_config(self.config)

        if show_msg:
            messagebox.showinfo("Saved", "Configurations saved successfully!")

    def show_context_menu(self, event):
        item = self.queue_tree.identify_row(event.y)
        if item:
            # If the item under the mouse isn't selected, select it exclusively
            if item not in self.queue_tree.selection():
                self.queue_tree.selection_set(item)
        self.queue_menu.tk_popup(event.x_root, event.y_root)

    def copy_urls(self, event = None):
        selected_items = self.queue_tree.selection()
        urls = [self.queue_tree.item(item, "values")[0] for item in selected_items]

        if urls:
            self.root.clipboard_clear()
            self.root.clipboard_append("\n".join(urls))
            self.root.update()  # Keeps the clipboard populated after the function returns

    def log_output(self, text):
        self.cmd_output.config(state = 'normal')
        self.cmd_output.insert(tk.END, text)
        self.cmd_output.see(tk.END)
        self.cmd_output.config(state = 'disabled')

    def update_tree_status(self, item_id, new_status):
        current_values = self.queue_tree.item(item_id, "values")
        self.queue_tree.item(item_id, values = (current_values[0], new_status))

    def update_progress(self, percentage):
        self.progress_var.set(percentage)

    def remove_selected(self):
        selected_items = self.queue_tree.selection()
        for item in selected_items:
            status = self.queue_tree.item(item, "values")[1]
            if status != "Downloading...":
                self.queue_tree.delete(item)

    # --- DOWNLOAD LOGIC ---
    def queue_urls(self):
        self.save_settings(show_msg = False)

        if not self.config.get('ytdlp_path'):
            messagebox.showerror("Error",
                                 "Please select your yt-dlp executable in the Configuration tab.")
            return

        urls = self.url_input.get("1.0", tk.END).strip().split()
        if not urls:
            return

        self.url_input.delete("1.0", tk.END)
        for u in urls:
            self.queue_tree.insert("", tk.END, values = (u, "Queued"))

        if not self.is_downloading:
            self.is_downloading = True
            threading.Thread(target = self.process_queue, daemon = True).start()

    def process_queue(self):
        while True:
            items = self.queue_tree.get_children()
            target_item = None
            target_url = ""

            for item in items:
                if self.queue_tree.item(item, "values")[1] == "Queued":
                    target_item = item
                    target_url = self.queue_tree.item(item, "values")[0]
                    break

            if not target_item:
                break

            self.root.after(0, self.update_tree_status, target_item, "Downloading...")
            self.root.after(0, self.log_output, f"\n🚀 Starting: {target_url}\n")
            self.root.after(0, self.update_progress, 0.0)

            # Base command setup
            cmd = [
                self.config['ytdlp_path'],
                "--newline",
                "--embed-metadata",
                "--embed-thumbnail",
                "--no-post-overwrites",
                "-P", self.config['output_dir']
            ]

            # Parse Format Setup (Audio vs Video)
            format_type = self.config.get('format_type', 'Audio')

            if format_type == "Audio":
                cmd.extend(["-f", "ba", "-x"])
                cmd.extend(["--ppa", "ThumbnailsConvertor+ffmpeg_o:-c:v png -vf crop='ih'"])

                codec = self.config.get('audio_codec', 'opus')
                if codec == 'mka':
                    cmd.extend(["--remux-video", "mka"])
                elif codec == 'mp4':
                    cmd.extend(["--remux-video", "mp4"])
                elif codec != 'none (keep original)':
                    cmd.extend(["--audio-format", codec])
            else:
                # Video logic Setup
                res = self.config.get('video_res', 'Best')
                res_str = "" if res == 'Best' else f"[height<={res.replace('p', '')}]"

                audio_pref = self.config.get('video_audio_pref', 'Best Audio (Default)')

                # Hierarchical Sorting string.
                # If "Highly Compatible" is chosen, prioritize finding an internal AAC/M4A audio stream first,
                # before safely falling back to whatever the best audio stream is.
                if audio_pref == 'Highly Compatible (AAC/M4A)':
                    cmd.extend(
                        ["-f", f"bv*{res_str}+ba[ext=m4a]/bv*{res_str}+ba/b{res_str} / best"])
                else:
                    cmd.extend(["-f", f"bv*{res_str}+ba/b{res_str} / best"])

                video_ext = self.config.get('video_ext', 'mp4')
                cmd.extend(["--merge-output-format", video_ext])

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

            # Run Subprocess
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
                    self.root.after(0, self.log_output, line)

                    match = PROGRESS_PATTERN.search(line)
                    if match:
                        try:
                            percentage = float(match.group(1))
                            self.root.after(0, self.update_progress, percentage)
                        except ValueError:
                            pass

                process.wait()

                if process.returncode == 0:
                    self.root.after(0, self.update_tree_status, target_item, "✅ Done")
                else:
                    self.root.after(0, self.update_tree_status, target_item, "❌ Error")

            except Exception as e:
                self.root.after(0, self.log_output, f"System Error: {str(e)}\n")
                self.root.after(0, self.update_tree_status, target_item, "❌ Failed")

        self.root.after(0, self.update_progress, 0.0)
        self.root.after(0, self.log_output, "\n🎉 Queue Complete!\n")
        self.is_downloading = False


if __name__ == "__main__":
    root = tk.Tk()
    app = YTDLPApp(root)
    root.mainloop()