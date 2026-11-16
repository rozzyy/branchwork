# Branchwork — Desain aplikasi yang sederhana

**STATUS: DIBATALKAN untuk bagian visual pada 2026-11-17.** Arah desain yang berjalan kini adalah [app-navigation-direction.md](./app-navigation-direction.md) — tampilannya tetap sama seperti aplikasi sekarang, dan yang berubah hanya navigasinya. Mockup `app-shell-v2.html` yang beraliran icon-rail bukan pilihan visual yang disetujui.

**Arah lama:** *satu konteks, satu perintah, satu workspace.*

Tujuan arah ini bukan menambah mode atau menyembunyikan fitur. Semua fitur tetap ada. Yang disederhanakan adalah **cara menemukan, memilih, dan berpindah konteks** — pengguna tidak perlu memahami struktur internal aplikasi untuk bekerja.

## Ringkasan keputusan

| Keputusan | Alasan |
| --- | --- |
| Titlebar hanya menampilkan konteks aktif + satu command field | Konteks proyek/worktree/branch dan pencarian adalah pekerjaan utama yang selalu terlihat. |
| Sidebar menjadi rail 8 destinasi utama | Navigasi harus bisa dikenali dalam 2 detik; pengelolaan proyek/group tidak lagi menempati sidebar primer. |
| Project dan worktree memilih lewat dua overlay dengan perilaku yang sama | Pengguna tidak perlu mempelajari dua pola pemilih yang berbeda lagi. |
| Overlay selalu punya mode **Switch** dan **Manage** | Mode Switch hanya berisi pekerjaan rutin (cari, pilih, pindah). Mode Manage menampung pengaturan, hapus, clone, dan pin tanpa menghalangi pekerjaan harian. |
| Stage tetap tab + split pane | Split view dan stage tabs adalah kekuatan aplikasi; yang disederhanakan adalah terlihat satu pane secara default, bukan menghilangkan multiview. |
| Setiap pane punya judul, konteks, aksi primer, dan overflow | Layar tidak lagi berlomba mengisi pane dengan tombol sekunder. |
| Status operasional hanya di status bar | Branch, dirty state, sync, agent, dan terminal tetap terlihat, tetapi tidak bertengkar dengan judul pane. |

## Diagnosis (berbasis audit kode)

Struktur aplikasi saat ini memiliki lima permukaan navigasi atau konteks yang tumpang tindih:

1. **Titlebar**: breadcrumb grup → project → worktree, pencarian command palette, theme toggle, bantuan.
2. **Sidebar**: brand, project picker, worktree, daftar screens, settings.
3. **Stage tabs**: workspace tabs di atas canvas.
4. **Pane toolbar**: judul layar, aksi layar-spesifik, pane controls (pin, split, swap, orientasi, close, menu).
5. **Status bar**: branch, dirty state, sync, agent count, dock toggle.

Hasilnya pengguna harus memahami perbedaan istilah seperti *project*, *group*, *worktree*, *stage tab*, dan *pane* sebelum menyelesaikan pekerjaan sehari-hari.

Masalah utama yang ditemukan:

- Project memakai tiga jalur berbeda (titlebar breadcrumb, sidebar picker, dan pin chip), masing-masing dengan state lokal sendiri. Ini sudah menimbulkan masalah popover duplikat.
- Daftar project bersekat grup; grup yang ter lipat menyembunyikan project.
- Pengelolaan grup dan pemilihan project berada dalam satu daftar yang sama.
- Tidak ada navigasi keyboard di switcher project/worktree.
- Setiap layar membawa toolbar sendiri, sehingga pane sempit penuh dengan aksi sekunder.
- Project dan worktree bergantung pada scope global tunggal; pin per pane sudah ditambahkan, tapi permukaannya belum sepenuhnya konsisten di semua layar.

## Arsitektur informasi

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Titlebar: konteks aktif │ ⌕ Search / command · Cmd K │ ⋯                  │
├──────────┬─────────────────────────────────────────────────────────────────┤
│ Icon rail │ Stage tabs: Main · Auth · +                                   │
│           ├─────────────────────────────────────────────────────────────────┤
│ Home      │ Pane header: Judul layar · pin konteks · aksi primer · ⋯      │
│ Changes   ├─────────────────────────────────────────────────────────────────┤
│ History   │ Konten utama                                                  │
│ Files     │                                                                 │
│ Agents    │                                                                 │
│ Terminal  │                                                                 │
│ GitHub    │                                                                 │
│ Browser   │                                                                 │
│           │                                                                 │
│ ⚠         │                                                                 │
│ ⚙         ├─────────────────────────────────────────────────────────────────┤
│           │ Branch · status · sync · agent · terminal                     │
└──────────┴─────────────────────────────────────────────────────────────────┘
```

### 1. Titlebar

*Hanya untuk menunjukkan konteks dan memanggil perintah.*

- **Konteks aktif**: tombol tunggal berisi dot warna grup + `project` + `worktree/branch`, misalnya `web-app / main`.
- Klik konteks membuka switcher (Switch mode) yang dipakai untuk project dan worktree.
- **Command field**: placeholder “Search, jump, or ask…”, menekan `⌘K` membuka satu command palette untuk layar, aksi, project, worktree, file, dan terminal.
- Aksi theme dan bantuan masuk ke overflow `⋯`; keduanya tidak lagi jadi kolom tetap di titlebar.

**Alur:** klik konteks → ketik nama → ↑↓ → Enter. Escape selalu keluar dan mengembalikan fokus ke trigger.

### 2. Icon rail

Sidebar lebar diganti rail kira-kira 72px. Urutan tetap:

1. `Home` `⌘1`
2. `Changes` `⌘2` (badge jumlah perubahan)
3. `History` `⌘3`
4. `Files` `⌘4`
5. `Agents` `⌘5` (badge agent menunggu)
6. `Terminal` `⌘6`
7. `GitHub` `⌘7`
8. `Browser`
9. `Conflicts` (di bagian bawah, badge hanya saat ada konflik)
10. `Settings`

Label hanya muncul untuk item aktif; item lain memakai tooltip. Ikon adalah pemandu lokasi; teks utama layar tetap ada di pane header.

### 3. Project dan worktree switcher

Satu komitmen interaksi untuk keduanya:

- Field cari selalu autofocus.
- Hasil berupa flat list. Grup menjadi label mati (`Grup: Acme · Work`), bukan langkah tambahan.
- `Terakhir dibuka` muncul di atas saat tidak mencari.
- `↑`/`↓` memindah sorotan; `Enter` memilih; `Esc` menutup.
- Pindah selalu lewat satu jalur `selectProject`/`selectWorktree`, sehingga guard “dirty edit” tetap berlaku.
- Tombol kaki kanan: **Kelola grup & repo…** / **Kelola worktree…**.

#### Mode Manage

- Panel yang sama, tetapi tambahan kontrol manajemen tampil.
- Project: ubah nama/warna grup, hapus grup, pindah project, open/clone repository, unpin pane.
- Worktree: pin untuk sidebar, buat worktree baru, hapus worktree.
- Tombol **← Kembali** selalu tersedia; pengguna tidak terjebak dalam manajemen.

### 4. Stage, tabs, dan pane

- Stage tabs tetap memakai lebar kartu tetap atau pola tab yang sama seperti aplikasi modern. Tab aktif jelas dan bisa diganti lewat keyboard/palette.
- Satu pane adalah *mode default* yang sederhana. Split adalah konsep lanjutan: tombol split di pane header, drag untuk membagi, separator untuk mengubah ukuran, double-click untuk equalize.
- Setiap pane mempunyai struktur tetap:

  ```text
  [Judul layar] [chip konteks project/worktree] ... [aksi primer] [⋯]
  ```

- Aksi sekunder (split menu, swap, orientasi, move to new window, close) tetap tersedia, tetapi hanya pada overflow `⋯`, kecuali split yang memang mudah diakses.
- Pin project per pane tetap memakai chip konteks. “Follow global project” adalah opsi pertama di switcher, bukan status yang harus ditafsirkan.

### 5. Status bar

Status bar bukan panel navigasi. Isinya hanya *apa yang harus diketahui sekarang*:

- `⎇ branch`
- jumlah file berubah / bersih
- `↑ahead ↓behind`
- jumlah agent aktif / menunggu
- tombol Terminal (`Ctrl+``)

Konflik, perubahan, dan operasi penting mendapatkan banner kontekstual di dekat canvas. Tidak ditambahkan banner permanen baru.

## Pemetaan fitur tanpa pemotongan

| Fitur | Permukaan baru |
| --- | --- |
| Home, Changes, History, Files, Agents, Terminal, GitHub, Browser | Icon rail + `⌘1–⌘7`/palette |
| Conflicts | Icon rail bagian bawah + badge; banner saat konflik muncul |
| Settings | Icon rail bagian bawah; overlay dialog tetap ada |
| Group, project, open/clone/remove | Switcher Mode Manage |
| Worktree pin, picker, create | Worktree switcher Mode Manage + chip konteks di pane |
| Stage tabs, split, drag/gutter, swap, orientation | Stage tab bar + pane header |
| New agent/handover/race | Agents toolbar + dialog yang sama |
| Terminal dock, new tab, broadcast, split | Status bar, pane header, dan command palette |
| Shortcut sheet | `?` melalui command palette/palette sheet yang sama |
| Theme, base tint, accent hue, density | Settings tetap menampung semua; tidak ditambah control di titlebar |

## Sinyal visual

### Palet dan permukaan

- Netral dominan dengan satu aksen biru yang tenang.
- `--bg` sedikit lebih terang, `--text` bukan putih penuh.
- Aksesori warna (`success`, `warning`, `danger`, `info`, `agent`) hanya untuk status; tidak dipakai sebagai dekorasi.
- Grup memakai dot kecil, tidak diulang sebagai outline besar atau background berwarna.

### Tipografi dan skala

```text
12px  meta / shortcut / status
13px  isi utama / label
15px  judul pane
18px  judul dialog
24px  judul halaman / heading terbesar di pane
```

- Judul layar tetap 15px; tidak ditambah tipografi hero.
- Angka status memakai `tabular-nums`.
- Ikon monospace untuk status terminal/agent; teks UI memakai font sistem SF Pro.

### Spasi, radius, dan elevasi

- Grid 4px: 4, 8, 12, 16, 24, 32.
- Radius kontrol 6px; panel/popover 10px; pill hanya untuk chip/badge.
- Maksimal dua permukaan bertumpuk (base → raised/overlay). Shadow ditegaskan hanya untuk popover/dialog/toast.
- Pane flush dan persegi tetap dipertahankan untuk split view; pane tunggal tetap diberi border 1px dan radius 10px.

### Komponen

Bangun dari empat pola, bukan banyak pola lokal:

1. **List row** — untuk project, worktree, files, changes, command palette.
2. **Context chip** — untuk project/worktree aktif di pane.
3. **Context header** — metadata kecil + aksi primer + `⋯`.
4. **Command/list overlay** — untuk pencarian, pilih, kelola, dan konfirmasi.

## Kebijakan interaksi

- **Satu perintah, satu pekerjaan.** Klik baris berarti pindah/ Pilih. Manajemen memakai tombol atau mode khusus.
- **Keyboard selalu tersedia.** Jendela command, switcher, dan worktree picker mendukung ↑↓, Enter, Esc.
- **Aksi sekunder memakai overflow.** Jangan menurunkan nomor tombol jika pane sempit.
- **Perubahan konteks eksplisit.** Pin chip selalu menandakan pane yang berbeda dari scope global; label “ikut global” tidak dikarang dari warna saja.
- **Empty state punya aksi tunggal.** Contoh: “Open a project”, “Open Changes”, atau “Start an agent”, bukan kartu dengan banyak tombol.
- **Konfirmasi hanya untuk tindakan merusak.** Hapus grup dan discard changes tetap membutuhkan konfirmasi; berpindah project/worktree tidak.

## Responsif desktop

| Lebar | Pola |
| --- | --- |
| `>1100px` | Rail 72px, satu pane, stage tabs penuh |
| `768–1100px` | Rail 56px ikon, aksi sekunder ke `⋯`, split tersedia |
| `<768px` | Rail disembunyikan; navigasi lewat command palette; pane aktif penuh dan header membungkus rapi |

## Jalur adopsi

1. **Prototipe shell** — satu HTML mockup interaktif untuk validasi pola, bukan refactor langsung.
2. **Token/komponen** — samakan chip, row, dan overlay; hapus menu lokal yang redundan.
3. **Titlebar + rail** — pindahkan konteks, navigasi, palette, dan settings/conflicts.
4. **Project/worktree switcher** — implementasikan Switch/Manage di aplikasi.
5. **Stage tabs + pane header** — samakan header di semua screens, pindahkan aksi ke overflow.
6. **Per-screen migration** — Home, Changes, History, Files, Agents, Terminal, GitHub, Browser, Conflicts, Settings.
7. **Aksesibilitas + E2E** — traversal keyboard, focus restore, empty/error states, dan regression test untuk popover single-instance.

## Ukuran keberhasilan

- Pengguna dapat berpindah project dengan `⌘⇧P`, command palette, atau switcher tanpa menyentuh mouse.
- Tidak ada permukaan baru yang membuka modal kedua untuk keputusan yang sama.
- Semua layar tetap dapat ditemukan tanpa mengingat toolbar masing-masing layar.
- Tidak ada fitur yang dipotong; manajemen hanya dipisahkan dari pekerjaan rutin.
