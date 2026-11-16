# Branchwork — arah navigasi (tampilan tidak diubah)

**Keputusan:** pertahankan tampilan Branchwork yang sekarang; yang diubah hanya cara berpindah konteks.

Arah sebelumnya yang menggagas rail 72px dan shell baru **dibatalkan** untuk visual. Dokumen ini adalah desain yang berjalan: seluruh permukaan, token, panel, toolbar, status bar, dan tema tetap sama. Satu-satunya fokus adalah menghilangkan pekerjaan navigasi yang berulang.

## Acuan Orca AI

Yang diambil dari Orca bukan gaya visualnya, melainkan pola navigasinya:

- **Sidebar sebagai pusat konteks.** Project, worktree, dan aktivitas agent dikelompokkan di kiri; area pusat tetap untuk terminal/tab/pane.
- **Jump Anywhere yang mengutamakan keyboard.** Daftar hasil dibuka dari *recents/activity*; agen yang menunggu ditampilkan duluan, lalu yang selesai dan idle.
- **Satu pencarian untuk banyak objek.** Project, worktree, tab, dan sesi terminal dapat ditemukan dari satu tempat, bukan dari lima picker berbeda.
- **Attention badge di tab.** Status agent/terminal (spinner, butuh input, selesai) ikut terbawa ke navigasi supaya pengguna tidak perlu mengingat tab mana yang membutuhkan perhatian.

## Yang tetap tidak berubah

- **Visual:** token warna, tipografi, radius, spacing, permukaan solid, status bar, dan pane flush dari `src/theme/tokens.css` dan CSS shell yang ada.
- **Struktur shell:** titlebar → sidebar → stage tabs → pane → status bar.
- **Fitur dan alur:** 10 screens, split hingga empat pane, stage tabs, project pin per pane, terminal dock, command palette, dialog konfirmasi, dan workflow Git/GitHub tetap tersedia.
- **Bahasa dan urutan ⌘1–⌘7:** Home, Changes, History, Files, Agents, Terminal, GitHub tidak diubah.

## Masalah yang diselesaikan

1. Project tetap dipisah oleh grup dan collapse state; pengguna harus mengintip beberapa grup untuk menemukan project.
2. Project, worktree, tab agent, dan file belum punya satu permukaan jump. Palette yang ada memuat banyak perintah, tetapi bukan pencarian aktivitas bernomor dengan hasil yang diurutkan menurut kebutuhan perhatian.
3. Sidebar mencampur posisi dengan kebijaksanaan (“saya sedang menumpang apa?”) dan aksi manajemen.
4. Stage tabs belum menampilkan badge perhatian dari agent terminal.

## Pengalaman navigasi yang diinginkan

### 1. Sidebar: tetap sama, daftar dibuat lebih mudah ditemukan

Sidebar tetap lebar dengan brand, picker project, daftar worktree, sections, dan settings. Perubahannya:

- **Tidak ada collapse pada daftar project default.** Grup menjadi label kelompok; semua project terlihat tanpa perlu membuka grup satu per satu.
- **Recent dulu, semua project kemudian.** Daftar project memakai urutan: project aktif → recent → daftar yang digabung rapi dan dapat dicari.
- **Worktree langsung terlihat.** Tiap baris menampilkan branch, status singkat (`● 3`, `Conflict`, `✓ clean`), dan jalur bila ruang membolehkan. Worktree aktif ditandai jelas; hanya pinned/active yang tampil pada posisi atas, sisanya boleh difilter pencarian.
- **Sections tetap compact:** `Screens`, `Tools`, lalu `Settings`. Conflict tetap di Tools, bukan diadu dengan layar primer.
- **Mouse dan keyboard sama-sama valid.** Fokus dapat pindah antar nav dengan Tab; picker dan Jump mendukung ↑↓/Enter/Esc.

### 2. Jump Anywhere: jalan utama berpindah konteks

Perintah primer: `⌘J` (Opsional/alternatif `⌘K` tetap membuka palette lama). Placeholder: **`repo / worktree`**.

Ketika dibuka tanpa query, tampilkan urutan:

1. **Perlu perhatian** — agent/terminal yang `waiting`, konflik, atau kesalahan.
2. **Recent chats & terminals** — hingga enam session sesuai aktivitas terakhir.
3. **Recent projects** — project terakhir dibuka.
4. **Worktrees/Files/Tabs** — hanya saat query membutuhkannya.

Baris hasil memakai komponen yang sama untuk project, worktree, agent, terminal, dan tab halaman. Setiap hasil menampilkan konteks sekunder (`project / branch` atau `Agents · waiting`) agar pilihan tidak ambigu.

Aturan:

- Query langsung menembus filter sidebar seperti Orca; hasil tersembunyi oleh collapse state tetap dapat ditemukan.
- `Tab` membuka filter project/host sederhana sebagai chip (tanpa mengubah koleksi data lain).
- `Enter` membuka hasil; `Esc` menutup dan mengembalikan fokus ke pemicu.
- Badge perhatian sama dengan tab bar: spinner (running), `?` (waiting), bell (notifikasi), check (selesai).
- Daftar dibekukan saat palette dibuka agar perintah baru/aktivitas tidak menggeser baris di bawah sorotan.

### 3. Picker project/worktree: operasi harian tanpa manajemen

Klik picker membuka daftar langsung:

- **Switch mode default:** cari, recents, daftar project/worktree datar, langsung pilih.
- **Manage mode terpisah:** tambah grup/project, clone/open repository, hapus, move, dsb. tetap ada, tetapi tidak bercampur dengan pilihan harian.
- Keyboard nav penuh tersedia di mode switch; baris aktif mudah terlihat.

### 4. Stage tabs: tab adalah bukti aktivitas, bukan hanya judul

Perilaku split, drag, gutter, swap, dan pane pin tetap sama. Perubahannya hanya:

- Tab menampilkan ikon/status attention saat agent/terminal butuh input atau berhenti.
- Urutan *recents/attention* hanya berlaku pada Jump Palette; jangan mengurutkan ulang stage tabs secara diam-diam.
- Stage tabs tetap menjadi tempat konten dokumen/terminal aktif; tidak diganti navigasi halaman global.

### 5. Pane header

Tidak ada perubahan visual. Header tetap menampilkan judul layar, aksi utama layar, dan pane controls. Project pin tetap sebagai chip; aksinya dipicu lewat switcher yang sama, bukan dialog terpisah.

## Peta perbandingan perilaku

| Sekarang | Arah baru |
| --- | --- |
| Buka grup untuk melihat project | Semua project datar tetap terlihat; grup hanya label pemisah |
| Klik picker project, gunakan mouse | `⌘J` atau picker, ↑↓ + Enter |
| Cari session dari Agents/Terminal | Jump punya recents yang diurutkan oleh kebutuhan perhatian |
| Mengubah kepemilikan grup menunggu di baris project | Pindah ke mode Manage di overlay yang sama |
| Worktree terlewat saat sidebar collapse/filter | Jump menembus filter dan menampilkan project/worktree target |
| Stage tab diam | Badge perhatian mengikuti sesi |

## Siklus interaksi target

1. Tekan `⌘J`.
2. Lihat agent yang menunggu di puncak, lalu session/project terakhir.
3. Ketik fragment (`web-feat`, `pos-app/fix/cart`, `api/main`, dll).
4. Pilih dengan ↑↓ dan buka dengan Enter.
5. Navigasi langsung ke project/worktree/tab tujuan; status aktivitas tetap terlihat.

## Batas dan kriteria sukses

- Tidak ada redesign visual pada token, panel, atau toolbar; file CSS visual tidak dibongkar untuk perubahan nav-only.
- Semua 10 screens dan fitur queue lama tetap dapat diakses.
- Query jump tidak hilang karena collapse state.
- Session yang butuh perhatian terlihat sebelum session idle.
- Satu popover project dalam satu waktu; perilaku duplicate-modal tetap dijaga oleh host tunggal.
- Fokus, Escape, dan pemulihan fokus dapat diautomatikus.
- Pada sidebar default, pengguna dapat menemukan setiap project tanpa membuka collapse group.

## Implementasi yang disarankan

1. Ganti state project picker: flatten list, recents, filter, keyboard nav, dan dual-mode.
2. Perluas store/commands: tambah `jump` (`⌘J`) yang menyatukan project, worktree, session, tab halaman, dan file sesuai peran query.
3. Samakan badge attention dengan sesi terminal/agent dan stage tab.
4. Terapkan perubahan sidebar list dan project/worktree picker di top-level React.
5. Tambahkan test komponen untuk keyboard, recents, dan query yang melewati filter.
6. Validasi manual di aplikasi macOS dan catat perilaku terminal blank/remount yang pernah terpengaruh overlay.

> Catatan: fitur manajemen repository dan grup tetap dilindungi lewat mode manage. Desain ini tidak menghapusnya; desain ini hanya menyembunyikannya dari jalan harian.
