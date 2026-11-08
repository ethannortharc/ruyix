// The App Center's catalog: Linux software picked by hand, every package from Debian trixie's main archive, built for
// both arm64 and amd64 (checked on packages.debian.org / madison, 2026-10-14). A graphical app ('gui') starts with its
// `command` on a display of its own; a command-line tool ('cli') is only installed — the agents and the terminal use it;
// a terminal ('term') is drawn in the page itself (xterm.js, lib/term.js), running `mux` (tmux or zellij) on a
// pseudo-terminal: text goes over the wire, not pixels, and the multiplexer keeps the shells when the window closes.
// Its `packages` may be empty: what the image carries (installed = the program is on PATH).
// `icon` is a lucide icon's name (the page maps the names it knows; an unknown one falls back to a plain box).
// `terminal`: a terminal (the page sends ⌘C as its copy key, not ⌃C, and keeps the other ⌘ shortcuts from it).
// `dark: false`: always light, whatever the page's tone (LibreOffice: its icons are unreadable on GTK's dark theme).
// GNOME's own apps come first where there is one (GTK 4 and libadwaita: a modern look, light and dark); the light Xfce
// ones stay for whoever has them.

/** A Debian package name, as apt takes it (also what "install by name" accepts). */
export const PACKAGE = /^[a-z0-9][a-z0-9+.-]{1,63}$/

/** What a graphical app needs besides itself: the virtual display (Xvnc), a window manager that fills the display with
 * the app's window, CJK fonts, a session bus and xauth — and its look (lib/display.js): the icon themes, the SVG loader
 * they need, Inter and JetBrains Mono. The box image carries them; a box without them installs them. */
export const GUI_SUPPORT = ['tigervnc-standalone-server', 'matchbox-window-manager', 'fonts-noto-cjk', 'dbus-x11', 'xauth',
  'adwaita-icon-theme', 'papirus-icon-theme', 'librsvg2-common', 'fonts-inter', 'fonts-jetbrains-mono']

/** xterm's copy and paste on keys the page can send for ⌘C (a terminal's ⌃C stops the program running). */
export const XTERM_KEYS = 'XTerm.vt100.translations: #override\\n Shift Ctrl <Key>C: copy-selection(CLIPBOARD)\\n Shift Ctrl <Key>V: insert-selection(CLIPBOARD)'

export const CATEGORIES = ['system', 'office', 'internet', 'graphics', 'develop', 'media', 'documents', 'data']

const gui = (id, name, summary, packages, command, icon, category, more = {}) => ({ id, name, summary, kind: 'gui', packages, command, icon, category, ...more })
const cli = (id, name, summary, packages, icon, category) => ({ id, name, summary, kind: 'cli', packages, command: null, icon, category })
const term = (id, name, summary, packages, mux, icon) => ({ id, name, summary, kind: 'term', packages, command: null, mux, icon, category: 'system', terminal: true })

export const CATALOG = [
  // (zellij: not in Debian's archive — the image carries zellij-org's own release, its sum checked; no package to
  // install, so a box on an older image says so instead)
  term('terminal', { zh: '终端', en: 'Terminal' }, { zh: '盒子里的命令行，字由浏览器画：清楚，中文输入、复制粘贴照常；关掉窗口再打开，里面的东西都还在（tmux）', en: 'Command lines inside the box, drawn by the browser: sharp, with your input method and clipboard; close the window and open it again, everything is still there (tmux)' },
    ['tmux'], 'tmux', 'SquareTerminal'),
  term('zellij', { zh: '终端（Zellij）', en: 'Terminal (Zellij)' }, { zh: '同样画在浏览器里的终端，里面跑 Zellij：分屏、标签页、浮动窗格，底部一直有快捷键提示', en: 'The same in-browser terminal running Zellij: panes, tabs and floating panes, with its keys always shown at the bottom' },
    [], 'zellij', 'PanelsTopLeft'),
  gui('console', { zh: '终端（GNOME 控制台）', en: 'Terminal (GNOME Console)' }, { zh: '在盒子里开命令行，可以开多个标签页', en: 'Command lines inside the box, in tabs' },
    ['gnome-console'], ['kgx'], 'Terminal', 'system', { terminal: true }),
  gui('nautilus', { zh: '文件（GNOME 文件）', en: 'Files (GNOME Files)' }, { zh: '浏览、搜索、整理盒子里的文件', en: 'Browse, search and organise the files in the box' },
    ['nautilus'], ['nautilus', '--new-window'], 'Folder', 'system', { files: true }),
  gui('xterm', { zh: '终端（xterm）', en: 'Terminal (xterm)' }, { zh: '在盒子里开一个命令行窗口', en: 'A command-line window inside the box' },
    ['xterm'], ['xterm', '-fa', 'DejaVu Sans Mono', '-fs', '11', '-xrm', XTERM_KEYS], 'Terminal', 'system', { terminal: true }),
  gui('thunar', { zh: '文件管理器（Thunar）', en: 'Files (Thunar)' }, { zh: '浏览、复制、移动盒子里的文件', en: 'Browse, copy and move the files in the box' },
    ['thunar'], ['thunar'], 'Folder', 'system', { files: true }),
  gui('text-editor', { zh: '文本编辑器（GNOME）', en: 'Text Editor (GNOME)' }, { zh: '干净好用的文本编辑器，带标签页和语法高亮', en: 'A clean text editor with tabs and syntax highlighting' },
    ['gnome-text-editor'], ['gnome-text-editor'], 'FileText', 'office'),
  gui('calculator', { zh: '计算器', en: 'Calculator' }, { zh: '基本、科学、程序员和财务计算', en: 'Basic, scientific, programming and financial calculations' },
    ['gnome-calculator'], ['gnome-calculator'], 'Calculator', 'office'),
  gui('mousepad', { zh: '文本编辑器（Mousepad）', en: 'Text editor (Mousepad)' }, { zh: '简单好用的纯文本编辑器', en: 'A simple plain-text editor' },
    ['mousepad'], ['mousepad'], 'FileText', 'office'),
  gui('geany', { zh: '代码编辑器（Geany）', en: 'Code editor (Geany)' }, { zh: '轻量的代码编辑器，带语法高亮和项目侧栏', en: 'A light code editor with syntax highlighting and a project sidebar' },
    ['geany'], ['geany'], 'Code', 'develop'),
  // one entry: Writer, Calc and Impress share one LibreOffice process per user — a second one started on another
  // display would hand its document to the first and exit at once
  gui('libreoffice', { zh: 'LibreOffice 办公套件', en: 'LibreOffice' }, { zh: '文档、表格、演示文稿（Writer、Calc、Impress）', en: 'Documents, spreadsheets and presentations (Writer, Calc, Impress)' },
    // (libreoffice-gtk3: drawn with GTK, sharp on a Retina screen and in the system's look — without it LibreOffice draws
    // its own small X11 controls)
    ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress', 'libreoffice-gtk3'], ['libreoffice', '--norestore'], 'Briefcase', 'office', { dark: false }),
  gui('papers', { zh: 'PDF 阅读器（Papers）', en: 'Document viewer (Papers)' }, { zh: '看 PDF 和其他文档', en: 'Read PDF and other documents' },
    ['papers'], ['papers'], 'BookOpen', 'documents'),
  gui('loupe', { zh: '看图（Loupe）', en: 'Image viewer (Loupe)' }, { zh: '看图片，缩放、旋转', en: 'View pictures, zoom and rotate them' },
    ['loupe'], ['loupe'], 'Image', 'graphics'),
  gui('firefox', { zh: 'Firefox 浏览器', en: 'Firefox' }, { zh: '在盒子里上网（Firefox ESR）', en: 'Browse the web from inside the box (Firefox ESR)' },
    ['firefox-esr'], ['firefox-esr'], 'Globe', 'internet'),
  // the agents' browser (lib/browser.js, docs/design/browser.md): the box's Playwright Chromium — it comes with the
  // image, no package; its command is found where it is (index.js), the profile that keeps its logins is ~/.ruyix/browser
  gui('agent-browser', { zh: '智能体浏览器', en: 'Agents\' browser' }, { zh: '你和智能体共用的浏览器，登录一直在：智能体用它查资料、填表，发布、付款这类最后一下留给你', en: 'The browser you and the agents share, logins kept: the agents look things up and fill forms in it; the last click — publishing, paying — is yours' },
    [], ['ruyix-agent-browser'], 'Globe', 'internet', { image: true }),
  gui('gimp', { zh: '图像处理（GIMP）', en: 'Image editor (GIMP)' }, { zh: '修图、调色、图层编辑', en: 'Retouch, adjust colours, edit in layers' },
    ['gimp'], ['gimp'], 'Palette', 'graphics'),
  gui('inkscape', { zh: '矢量绘图（Inkscape）', en: 'Vector drawing (Inkscape)' }, { zh: '画和编辑 SVG 矢量图', en: 'Draw and edit SVG vector graphics' },
    ['inkscape'], ['inkscape'], 'PenTool', 'graphics'),

  cli('ffmpeg', { zh: 'FFmpeg', en: 'FFmpeg' }, { zh: '转换、剪切、合并音视频', en: 'Convert, cut and join audio and video' }, ['ffmpeg'], 'Film', 'media'),
  cli('imagemagick', { zh: 'ImageMagick', en: 'ImageMagick' }, { zh: '在命令行里批量处理图片', en: 'Process images in batches from the command line' }, ['imagemagick'], 'Image', 'media'),
  cli('yt-dlp', { zh: 'yt-dlp', en: 'yt-dlp' }, { zh: '下载网页上的视频和音频', en: 'Download video and audio from web pages' }, ['yt-dlp'], 'Download', 'media'),
  cli('pandoc', { zh: 'Pandoc', en: 'Pandoc' }, { zh: '文档格式互转（Markdown、Word、HTML…）', en: 'Convert documents between formats (Markdown, Word, HTML…)' }, ['pandoc'], 'Repeat', 'documents'),
  cli('poppler-utils', { zh: 'PDF 工具（poppler-utils）', en: 'PDF tools (poppler-utils)' }, { zh: 'pdftotext、pdftoppm 等：从 PDF 取文字和图片', en: 'pdftotext, pdftoppm and more: text and images out of PDFs' }, ['poppler-utils'], 'FileText', 'documents'),
  cli('tesseract', { zh: '文字识别（Tesseract）', en: 'Text recognition (Tesseract)' }, { zh: '从图片里识别文字，含简体中文', en: 'Read text out of images, Simplified Chinese included' }, ['tesseract-ocr', 'tesseract-ocr-chi-sim'], 'ScanText', 'documents'),
  cli('ripgrep', { zh: 'ripgrep', en: 'ripgrep' }, { zh: '在文件里快速搜索文字（rg）', en: 'Search text in files, fast (rg)' }, ['ripgrep'], 'Search', 'develop'),
  cli('git-lfs', { zh: 'Git LFS', en: 'Git LFS' }, { zh: '让 git 管理大文件', en: 'Large files in git' }, ['git-lfs'], 'GitBranch', 'develop'),
  cli('jq', { zh: 'jq', en: 'jq' }, { zh: '在命令行里查询和改写 JSON', en: 'Query and reshape JSON from the command line' }, ['jq'], 'Braces', 'data'),
  cli('sqlite3', { zh: 'SQLite', en: 'SQLite' }, { zh: 'SQLite 数据库的命令行', en: 'The SQLite database\'s command line' }, ['sqlite3'], 'Database', 'data'),
]

/** The catalog entry by id (undefined: none). */
export const entry = id => CATALOG.find(a => a.id === id)

/** Package names, checked: an array of 1–24 valid names, deduplicated; throws a coded error otherwise. */
export function checkPackages(list) {
  const names = [...new Set((Array.isArray(list) ? list : [list]).map(x => String(x ?? '').trim()).filter(Boolean))]
  const bad = names.find(n => !PACKAGE.test(n))
  if (bad !== undefined) throw Object.assign(new Error(`not a Debian package name: ${bad.slice(0, 80)}`), { code: 'badPackage', params: { name: bad.slice(0, 80) } })
  if (!names.length || names.length > 24) throw Object.assign(new Error('1 to 24 package names'), { code: 'badPackage', params: { name: '' } })
  return names
}
