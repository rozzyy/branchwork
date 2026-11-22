# Software Factory: Spesifikasi

Versi 0.1 (draf). Status: siap ditinjau sebelum implementasi.

## 1. Tujuan

Membangun pipeline pengembangan perangkat lunak yang dijalankan coding agent secara otomatis dari permintaan sampai pull request, dengan manusia hanya dipanggil di titik keputusan. Pipeline dipantau dan dikendalikan lewat satu dashboard web.

### Prinsip

1. **Otomatis secara default.** Setiap langkah dikerjakan agent. Manusia hanya muncul di gerbang yang didefinisikan di kebijakan.
2. **Keputusan alur ada di kode, bukan di LLM.** Orkestrator memutuskan transisi tahap dengan aturan pasti. Model hanya bekerja di dalam satu tahap.
3. **Setiap tahap punya kontrak keluaran terstruktur.** Orkestrator tidak membaca prosa agent untuk mengambil keputusan.
4. **Gagal dengan aman.** Setiap loop punya batas percobaan, setiap tugas punya batas biaya, dan kegagalan berujung eskalasi ke manusia, bukan loop tanpa akhir.
5. **Satu sumber kebenaran.** State tugas disimpan di basis data orkestrator. Dashboard hanya membaca dan menulis keputusan lewat API.

### Di luar lingkup (versi 0.1)

- Deploy ke produksi (berhenti di PR yang di-merge).
- Banyak repositori dalam satu tugas.
- Multi-tenant dan autentikasi pengguna berlapis. Versi awal untuk satu pengguna atau satu tim kecil.

## 2. Komponen dan perannya

Setiap komponen punya satu peran agar instruksinya tidak bentrok.

| Komponen | Peran | Dipakai di tahap |
|---|---|---|
| harness-creator | Fondasi repo: AGENTS.md atau CLAUDE.md, daftar fitur, gerbang verifikasi, batas scope, serah-terima sesi | Setup, audit berkala |
| superpowers | Konduktor proses: brainstorming, rencana, implementasi dengan subagent, TDD, verifikasi | Rencana, Bangun |
| pstack | Playbook per jenis tugas (bug, fitur, refactor, investigasi) yang dipanggil dari tahap Bangun | Bangun |
| ponytail | Membatasi scope dan jumlah kode; `ponytail-review` untuk mencari yang bisa dipangkas | Bangun, Tinjau |
| thermo-nuclear-code-quality-review | Gerbang kualitas struktural (read-only) | Tinjau |
| caveman | Menekan verbositas output untuk menghemat token | Worker subagent saja |

Catatan penting:

- **Hanya satu orkestrator proses.** superpowers adalah konduktor. pstack dipanggil sebagai playbook, tidak boleh mengambil alih alur.
- **Caveman tidak dipakai untuk artefak yang dibaca manusia** (rencana, laporan review, pesan commit).
- **Urutan di Tinjau:** ponytail-review dulu, lalu thermo-nuclear. Temuan thermo-nuclear yang butuh refactor di luar scope tugas dicatat sebagai tugas baru, bukan dikerjakan di tugas berjalan.
- **Perlu diverifikasi sebelum implementasi:** nama command dan cara pemicuan tiap skill di versi yang terpasang. Ada beberapa skill dengan nama `harness-creator` dari penulis berbeda; pilih satu dan kunci versinya. Skill thermo-nuclear di salah satu varian tidak dipanggil otomatis oleh model, jadi harus dipicu eksplisit oleh orkestrator.

## 3. Arsitektur

```
 Dashboard (React)  <--SSE/REST-->  API Server  <-->  Basis data (SQLite)
        |                               |
        | keputusan, prompt             | antrean job
        v                               v
                              Orkestrator (mesin state)
                                        |
                       +----------------+----------------+
                       |                |                |
                  Job Rencana      Job Bangun       Job Tinjau ...
                  (worktree A)     (worktree A)     (worktree A)
                       |                |                |
                       +--- Claude Code headless / Agent SDK ---+
                                        |
                              Hook -> event JSON -> Event store
```

### Proses

| Proses | Tanggung jawab |
|---|---|
| Orkestrator | Memuat state, mengambil tugas yang siap, menjalankan job tahap, memvalidasi keluaran, menerapkan transisi dan kebijakan |
| Runner | Membuat worktree, menjalankan agent secara headless dengan prompt tahap, menangkap keluaran dan event, menegakkan timeout |
| API server | REST untuk dashboard, SSE untuk event langsung, menulis keputusan dan prompt manusia ke basis data |
| Dashboard | Papan pipeline, detail tugas, panel prompt, kebijakan, metrik |

Orkestrator dan API server boleh satu proses pada versi awal.

### Isolasi

- Satu **git worktree** dan satu **branch** per tugas (`factory/<task-id>`).
- Satu job aktif per tugas pada satu waktu.
- Batas paralelisme global (`max_parallel_tasks`).
- Orkestrator tahan restart: seluruh state dari basis data, job yang terputus dijalankan ulang dari awal tahap berdasarkan heartbeat.

## 4. Model data

### Task

| Field | Tipe | Keterangan |
|---|---|---|
| id | string | `FAC-<angka>` |
| title | string | Ringkasan satu baris |
| kind | enum | `bug`, `feature`, `refactor`, `investigation`, `migration`, `other` |
| playbook | string | Playbook pstack atau alur superpowers yang dipilih |
| stage | enum | `plan`, `build`, `review`, `verify`, `ship`, `done` |
| status | enum | `running`, `gate`, `blocked`, `paused`, `done`, `cancelled` |
| gate_reason | enum atau null | `plan_approval`, `merge_approval`, `risk_review` |
| block_reason | enum atau null | `retries_exhausted`, `budget_exceeded`, `job_failed`, `timeout` |
| retry | int | Jumlah perbaikan otomatis di loop review atau verifikasi |
| tokens | int | Akumulasi |
| cost_usd | decimal | Akumulasi |
| budget_usd | decimal | Batas per tugas |
| branch | string | Nama branch |
| worktree | string | Path worktree |
| pr_url | string atau null | Diisi di tahap Rencana akhir atau Ship |
| created_at, updated_at | timestamp | |

### StageRun

Satu baris per eksekusi tahap: `id`, `task_id`, `stage`, `attempt`, `status` (`running`, `succeeded`, `failed`), `started_at`, `finished_at`, `tokens`, `cost_usd`, `result_json`, `log_path`.

### Finding

`id`, `task_id`, `stage_run_id`, `source` (`thermo-nuclear`, `ponytail-review`, `verify-gate`), `severity` (`blocking`, `suggestion`), `message`, `file`, `line` (opsional), `resolved` (bool).

### Event

Append-only: `id`, `task_id`, `ts`, `type`, `payload_json`. Dashboard dan log kejadian membaca dari tabel ini. Jenis event: `task.created`, `stage.started`, `stage.finished`, `finding.added`, `retry.started`, `gate.opened`, `gate.decided`, `task.blocked`, `prompt.received`, `cost.updated`, `autopilot.changed`.

### Decision

`id`, `task_id`, `gate`, `decision` (`approve`, `return_to_build`, `cancel`), `note`, `decided_by`, `ts`.

### Prompt

`id`, `task_id` (null untuk tugas baru), `text`, `status` (`queued`, `delivered`), `ts`.

## 5. Mesin state

### Transisi otomatis

| Dari | Kondisi (guard) | Ke |
|---|---|---|
| (baru) | Tugas dibuat | `plan`/`running` |
| `plan`/running | Job sukses, rencana valid | `plan`/`gate` (`plan_approval`) |
| `plan`/gate | Keputusan `approve` | `build`/running |
| `build`/running | Job sukses, diff tidak menyentuh path berisiko | `review`/running |
| `build`/running | Job sukses, diff menyentuh path berisiko | `build`/`gate` (`risk_review`) |
| `build`/gate | Keputusan `approve` | `review`/running |
| `review`/running | Tidak ada temuan blocking | `verify`/running |
| `review`/running | Ada temuan blocking dan `retry < max_retries` | `build`/running, `retry += 1` |
| `review`/running | Ada temuan blocking dan `retry >= max_retries` | `review`/`blocked` (`retries_exhausted`) |
| `verify`/running | Semua gerbang lulus | `ship`/running (buat PR) lalu `ship`/`gate` (`merge_approval`) |
| `verify`/running | Gerbang gagal dan `retry < max_retries` | `build`/running, `retry += 1` |
| `verify`/running | Gerbang gagal dan `retry >= max_retries` | `verify`/`blocked` (`retries_exhausted`) |
| `ship`/gate | Keputusan `approve` | Merge, lalu `done` |
| tahap apa pun, running | `cost_usd > budget_usd` | `blocked` (`budget_exceeded`) |
| tahap apa pun, running | Job gagal atau timeout melewati batas ulang teknis | `blocked` (`job_failed` atau `timeout`) |

### Transisi oleh manusia

| Dari | Aksi | Ke |
|---|---|---|
| `blocked` atau gate | `return_to_build` (dengan catatan opsional) | `build`/running, `retry = 0`, catatan masuk sebagai prompt |
| gate atau `blocked` | `cancel` | `cancelled`, worktree dibersihkan |
| apa pun | Autopilot dijeda | Job yang sedang berjalan selesai, tidak ada job baru dimulai |

### Aturan loop

- `retry` dihitung per tugas, bukan per tahap, dan direset hanya oleh keputusan manusia.
- Temuan `blocking` dikirim ke tahap Bangun sebagai masukan perbaikan. Temuan `suggestion` dicatat tapi tidak memicu loop.
- Temuan thermo-nuclear yang membutuhkan refactor di luar scope tugas dibuat sebagai tugas baru dengan status `plan`/running dan `kind = refactor`, lalu tidak menghalangi tugas asal.

## 6. Kontrak tahap

Setiap job menerima konteks tugas dan wajib mengembalikan satu objek JSON yang valid terhadap skema tahapnya. Keluaran yang tidak valid dihitung sebagai job gagal (satu percobaan ulang teknis, lalu `blocked`).

### Masukan umum

```json
{
  "task_id": "FAC-101",
  "title": "Perbaiki filter pencarian yang reset saat ganti halaman",
  "kind": "bug",
  "worktree": "/work/FAC-101",
  "branch": "factory/FAC-101",
  "human_prompts": ["..."],
  "previous_findings": [],
  "policy": { "max_retries": 3 }
}
```

### Rencana

Tujuan: brainstorming singkat lalu rencana langkah demi langkah.

```json
{
  "status": "ok",
  "plan_path": "docs/plans/FAC-101.md",
  "steps": 6,
  "touched_paths_estimate": ["src/search/filter.ts"],
  "risk_flags": []
}
```

### Bangun

Tujuan: implementasi dengan TDD sesuai rencana, dengan ponytail aktif.

```json
{
  "status": "ok",
  "commits": ["a1b2c3d"],
  "files_changed": ["src/search/filter.ts", "src/search/filter.test.ts"],
  "tests": { "total": 12, "passed": 12, "failed": 0 },
  "skipped_or_unchecked": ["tidak menguji perilaku di Safari"]
}
```

`skipped_or_unchecked` wajib diisi. Orkestrator menampilkannya di detail tugas.

### Tinjau

Dua pemeriksaan paralel, hasilnya digabung orkestrator.

```json
{
  "status": "ok",
  "findings": [
    {
      "source": "thermo-nuclear",
      "severity": "blocking",
      "file": "src/auth/auth.ts",
      "message": "File berisi 1.240 baris; pisahkan penanganan token dari sesi."
    },
    {
      "source": "ponytail-review",
      "severity": "suggestion",
      "file": "src/http/retry.ts",
      "message": "Wrapper retry bisa dihapus; klien HTTP sudah menyediakannya."
    }
  ]
}
```

Pemeriksaan thermo-nuclear bersifat read-only. Job Tinjau tidak boleh mengubah berkas.

### Verifikasi

Dijalankan sebagai skrip deterministik dari harness (bukan oleh LLM): test, lint, typecheck, build.

```json
{
  "status": "ok",
  "gates": [
    { "name": "test", "passed": true },
    { "name": "lint", "passed": true },
    { "name": "typecheck", "passed": true }
  ],
  "failures": []
}
```

### Ship

Membuat PR (judul, deskripsi dari rencana dan hasil review, daftar `skipped_or_unchecked`). Merge dilakukan orkestrator hanya setelah keputusan `approve`.

## 7. Kebijakan

Disimpan di `factory.policy.yml` di akar repo pipeline dan dibaca ulang tiap siklus.

```yaml
autopilot: true

limits:
  max_retries: 3
  budget_usd_per_task: 4.00
  max_parallel_tasks: 3
  job_timeout_minutes:
    plan: 15
    build: 45
    review: 20
    verify: 20

gates:
  plan_approval: required
  merge_approval: required
  risk_review:
    paths:
      - "migrations/**"
      - "src/auth/**"
      - "**/package.json"
      - "**/*.lock"
      - ".github/workflows/**"

review:
  order: [ponytail-review, thermo-nuclear]
  out_of_scope_findings: new_task

skills:
  conductor: superpowers
  playbooks: pstack
  compression_workers_only: caveman
```

Aturan:

- Kebijakan yang tidak valid menghentikan orkestrator (gagal keras), bukan jatuh ke nilai default yang longgar.
- Perubahan kebijakan dicatat sebagai event dan hanya berlaku untuk job yang belum dimulai.

## 8. Pagar pengaman

Agent berjalan tanpa pengawas, jadi batasnya harus ditegakkan oleh sistem:

1. **Izin tool allowlist** per tahap. Tahap Tinjau hanya boleh membaca. Tahap Rencana tidak boleh mengubah kode.
2. **Tidak ada rahasia produksi** di lingkungan job. Kredensial dibatasi ke yang minimal untuk menjalankan test dan membuat PR.
3. **Jaringan dibatasi** ke domain yang diperlukan (registry paket, host git).
4. **Batas giliran, waktu, dan biaya** per job dan per tugas. Cek flag yang tersedia di versi Claude Code yang dipakai; jika batas biaya native tidak ada, orkestrator menghitung dari event penggunaan dan menghentikan job.
5. **Branch terlindungi.** Agent hanya mendorong ke `factory/*`. Merge ke branch utama hanya oleh orkestrator setelah keputusan manusia dan CI hijau.
6. **Konten dari repo atau hasil web dianggap data**, bukan instruksi. Prompt tahap menyatakan ini secara eksplisit.
7. **Jejak audit.** Semua keputusan, prompt, dan perubahan kebijakan masuk tabel Event dan tidak bisa dihapus lewat API.

## 9. Dashboard

### Layar utama (Papan)

- Lima kolom: Rencana, Bangun, Tinjau, Verifikasi, Rilis. Header kolom menampilkan skill yang aktif di tahap itu, dan penanda gerbang manusia.
- Kartu tugas: id, judul, playbook, status, token, hasil test, jumlah perbaikan (`n/3`), bilah progres untuk tugas berjalan.
- Status: **Berjalan**, **Menunggu Anda** (gerbang), **Butuh keputusan** (eskalasi), **Dijeda**.
- Bilah statistik: agent berjalan, menunggu Anda (gerbang ditambah eskalasi), token dan biaya hari ini, jumlah rilis.
- Bilah harness: hasil `validate-harness` dan kesegaran AGENTS.md.
- Panel kebijakan otomatis (lipat): apa yang dikerjakan agent dan kapan manusia dipanggil.

### Panel detail tugas

Posisi di pipeline, token, biaya, waktu, hasil test, temuan review (Harus diperbaiki dan Saran), log kejadian, `skipped_or_unchecked`, tombol keputusan (Setujui, Kembalikan ke Bangun, Batalkan). Tombol hanya aktif saat status `gate` atau `blocked`.

### Panel prompt

Mode tampilan: **Papan**, **Split** (lebar panel bisa diseret), **Prompt**. Di layar sempit panel pindah ke bawah.

- Pemilih tujuan: Tugas baru atau tugas yang ada. Memilih kartu mengatur tujuan otomatis.
- Chip skill menyisipkan awalan instruksi.
- Prompt ke tugas baru membuat tugas di tahap Rencana. Prompt ke tugas yang ada masuk antrean Prompt dan dikirim sebagai `human_prompts` pada job berikutnya; tidak menginterupsi job yang sedang berjalan.
- Ctrl+Enter untuk kirim.

### Kontrol global

Tombol **Autopilot** (aktif atau dijeda). Dijeda berarti tidak ada job baru dimulai; job yang sedang berjalan diselesaikan.

### Aksesibilitas dan tema

Responsif sampai ponsel, mode terang dan gelap, fokus keyboard terlihat, `prefers-reduced-motion` dihormati.

## 10. API

| Metode dan path | Fungsi |
|---|---|
| `GET /api/tasks` | Daftar tugas dengan status dan metrik ringkas |
| `POST /api/tasks` | Membuat tugas dari prompt (`{ "text": "...", "kind": "feature" }`) |
| `GET /api/tasks/:id` | Detail, stage run, temuan, event |
| `POST /api/tasks/:id/prompt` | Menambah prompt ke antrean tugas |
| `POST /api/tasks/:id/decision` | `{ "gate": "...", "decision": "approve" \| "return_to_build" \| "cancel", "note": "..." }` |
| `GET /api/events` | Aliran SSE seluruh event (`?task=FAC-101` untuk satu tugas) |
| `GET /api/stats` | Token, biaya, jumlah per status |
| `GET /api/policy` | Kebijakan aktif |
| `PUT /api/autopilot` | `{ "enabled": true \| false }` |
| `GET /api/harness` | Hasil validasi harness terakhir |

Aturan: keputusan ditolak (409) jika tugas tidak sedang berada di gerbang yang disebutkan. Semua perubahan menulis event.

## 11. Observabilitas dan metrik

Per tugas: token, biaya, waktu per tahap, jumlah percobaan ulang, jumlah temuan per sumber.

Per periode: rasio tugas selesai tanpa eskalasi, rasio eskalasi per sebab, rata-rata biaya per tugas per jenis, waktu tunggu di gerbang manusia, rasio loop perbaikan yang berhasil.

Sumber data: output job, hook Claude Code (`SubagentStop`, `Stop`, `PostToolUse`), dan ekspor telemetri OpenTelemetry jika tersedia. Verifikasi variabel dan event yang tepat di dokumentasi resmi sesuai versi yang dipakai. Band status ponytail tidak tersedia di mode `-p`, jadi tidak boleh dijadikan sumber metrik.

## 12. Struktur repositori yang diusulkan

```
software-factory/
  factory.policy.yml
  orchestrator/        # mesin state, penjadwal, penerapan kebijakan
  runner/              # worktree, eksekusi agent headless, penangkap event
  stages/
    plan.md            # templat prompt tiap tahap
    build.md
    review.md
    verify.sh          # gerbang deterministik
    schemas/*.json     # skema keluaran tiap tahap
  api/                 # REST dan SSE
  dashboard/           # aplikasi web
  db/migrations/
  docs/
```

## 13. Rencana implementasi

| Fase | Isi | Kriteria selesai |
|---|---|---|
| 0. Fondasi | Pilih versi tiap skill, jalankan harness-creator di repo percobaan, `validate-harness` lulus, jalankan satu tugas manual lewat semua tahap | Dokumen catatan benturan antar skill dan nama command yang valid |
| 1. Runner dan kontrak | Runner satu tahap berjalan headless di worktree, keluaran divalidasi skema | Setiap tahap menghasilkan JSON valid dari 5 tugas uji |
| 2. Orkestrator | Mesin state, kebijakan, loop perbaikan, batas biaya, eskalasi, pemulihan setelah restart | Tugas uji melewati pipeline tanpa campur tangan sampai gerbang; restart di tengah tidak menggandakan kerja |
| 3. API dan dashboard | Papan, detail, keputusan, SSE | Semua keputusan manusia bisa dilakukan lewat UI; status papan konsisten dengan basis data |
| 4. Panel prompt | Antrean prompt, tugas baru dari prompt | Prompt ke tugas berjalan muncul di `human_prompts` job berikutnya |
| 5. Pengerasan | Allowlist tool, pembatasan jaringan, audit, metrik | Daftar periksa pagar pengaman (bagian 8) lengkap |
| 6. Tuning | Ukur biaya dan nilai tiap komponen, matikan yang tidak berguna | Laporan biaya per tugas dan rekomendasi komponen yang dipertahankan |

### Kriteria penerimaan utama

1. Tugas jenis `bug` dan `feature` sederhana mencapai gerbang persetujuan merge tanpa intervensi manusia selain persetujuan rencana.
2. Tugas dengan temuan blocking diperbaiki otomatis dalam batas percobaan, atau dieskalasi dengan sebab yang jelas.
3. Tugas yang melewati batas biaya berhenti dan muncul sebagai "Butuh keputusan".
4. Tidak ada merge ke branch utama tanpa keputusan `approve` yang tercatat.
5. Seluruh jalannya tugas dapat direkonstruksi dari tabel Event.

## 14. Risiko dan pertanyaan terbuka

| Risiko | Mitigasi |
|---|---|
| Skill saling bertentangan (dua konduktor, gaya output berbeda) | Satu konduktor; caveman hanya di worker; uji pasangan skill di fase 0 |
| Klaim penghematan skill lebih tinggi dari hasil nyata (uji independen ponytail melaporkan angka lebih kecil dari klaim resminya) | Ukur sendiri di fase 6; jangan jadikan klaim sebagai target |
| Biaya membengkak oleh agent tambahan (arena, swarm, interrogate di pstack) | Aktifkan hanya untuk perubahan berisiko; batas biaya per tugas |
| Loop perbaikan tidak konvergen | Batas percobaan dan eskalasi |
| Agent bertindak di luar scope atau terpengaruh instruksi dalam konten repo | Allowlist tool, prompt tahap menandai konten sebagai data, branch terlindungi |
| Nama command atau perilaku skill berubah antar versi | Kunci versi, uji ulang saat memperbarui |

Pertanyaan terbuka:

1. Versi `harness-creator` mana yang dipakai?
2. Dipakai satu orang atau tim? Jika tim, perlu autentikasi dan peran (siapa boleh menyetujui merge).
3. Host eksekusi: mesin lokal, server sendiri, atau CI? Ini menentukan model isolasi dan rahasia.
4. Bahasa orkestrator: Node (searah dengan Agent SDK dan dashboard) atau Python.
5. Apakah gerbang risiko berbasis path cukup, atau perlu klasifikasi risiko oleh model di tahap Rencana?