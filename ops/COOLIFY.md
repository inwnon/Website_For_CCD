# ขึ้นระบบด้วย Coolify

ใช้ไฟล์ `docker-compose.coolify.yml` (ฐานข้อมูล + แอปในชุดเดียว) ส่วน `docker-compose.yml` เดิมยังใช้กับการพัฒนาในเครื่องและการติดตั้งแบบ `docker compose` ปกติ

ต่างจากไฟล์เดิม: ไม่เปิดพอร์ตออกนอกเครื่อง (Coolify ส่งคำขอผ่าน proxy ของมันทาง Docker network), เก็บไฟล์ใน named volume, ตั้ง `TRUST_PROXY=uniquelocal` และอ่านค่าจากหน้า Environment Variables ของ Coolify แทน `.env`

## 1. สร้างแอป
1. Coolify → Project → **+ New** → **Private Repository (with GitHub App)** → เลือก repo `inwnon/Website_For_CCD` สาขา `main`
2. Build Pack: **Docker Compose** · Base Directory `/` · Docker Compose Location `/docker-compose.coolify.yml`
3. **Domains** ของ service `app`: `https://โดเมนจริง:3000` (เช่น `https://news.sru.ac.th:3000` — `:3000` คือพอร์ตในคอนเทนเนอร์ ผู้ใช้เข้าด้วย 443 ตามปกติ) ส่วน `db` ไม่ต้องใส่โดเมน
4. ชี้ DNS ของโดเมนมาที่เครื่อง Coolify ก่อน deploy เพื่อให้ออกใบรับรอง HTTPS ได้

## 2. Environment Variables
กรอกในแท็บ Environment Variables (ห้ามใส่ในไฟล์ใน repo):

| ชื่อ | ค่า |
|---|---|
| `PGPASSWORD` | รหัสผ่านใหม่ที่ยาวและสุ่ม |
| `APP_ORIGIN` | `https://โดเมนจริง` (ไม่มี `/` ท้าย ไม่มีพอร์ต) |
| `GOOGLE_CLIENT_ID` | Client ID ของ OAuth (เพิ่มโดเมนนี้ใน Authorized JavaScript origins ด้วย) |
| `READ_SALT` | ข้อความสุ่มยาวอย่างน้อย 16 ตัวอักษร |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | ค่าของเมลเซิร์ฟเวอร์ (เว้นว่างได้ อีเมลจะค้างในคิวจนกว่าจะตั้ง) |
| `PGDATABASE` `PGUSER` | ไม่ต้องกรอก (ค่าเริ่มต้น `prsru`) |
| `DEVELOPER_EMAILS` | (ถ้าต้องการ) อีเมลผู้พัฒนาระบบเพิ่มเติม คั่นด้วย `,` — ผู้พัฒนาระบบเป็นผู้ดูแลระบบได้ทันทีและเห็นหมวด "กู้คืนทั้งระบบ" (`satearnpong.nis@sru.ac.th` มีอยู่แล้ว) |

`NODE_ENV=production` และ `ALLOW_DEV_LOGIN=0` ตั้งไว้ในไฟล์แล้ว แอปจะไม่ยอมเริ่มถ้าค่าข้างบนไม่ปลอดภัย (ดู log ของ `app`)

## 3. Deploy และผู้ดูแลคนแรก
1. กด **Deploy** — build image แล้วรัน migration ให้เองทุกครั้งที่แอปเริ่ม
2. เพิ่มแอดมินคนแรก: Coolify → **Terminal** → container `db`:
   ```sh
   psql -U prsru -d prsru -c "insert into pr_team (email, role) values ('ชื่อ@sru.ac.th', 'admin')"
   ```
3. อัปเดตเวอร์ชัน: merge เข้า `main` แล้วกด Deploy (หรือเปิด Auto Deploy ใน Coolify)

## 4. ย้ายข้อมูลจากเครื่องเดิม (ถ้าต้องการ)
ข้อมูลบนเครื่องใหม่จะถูก**แทนที่ทั้งหมด** ทำนอกเวลาทำงาน ข้อมูลที่เพิ่มบนเครื่องเดิมหลังสำรองจะไม่ตามมา

### 4.1 ผ่านหน้าเว็บ (ไม่ต้อง SSH เครื่อง Coolify)
1. บนเครื่องเดิม (SSH) สำรองฐานข้อมูลและไฟล์ แล้วดาวน์โหลดสองไฟล์ลงคอมพิวเตอร์ (เช่น `scp`):
   ```sh
   cd /srv/prsru
   docker compose exec -T db pg_dump -U prsru -d prsru -Fc > prsru.dump
   tar -czf uploads.tar.gz uploads
   ```
2. ล็อกอินเว็บใหม่ด้วยบัญชีผู้พัฒนาระบบ → `chanon.html` → หมวด **กู้คืนทั้งระบบ**
3. **1. ฐานข้อมูล**: เลือก `prsru.dump` พิมพ์ `กู้คืนทั้งหมด` → อัปโหลดและกู้คืน → รอจนขึ้น "กู้คืนฐานข้อมูลแล้ว" (ระบบเก็บสำเนาฐานข้อมูลเดิมไว้ใน `uploads/.restore/`, ถ้าผิดพลาดฐานข้อมูลยังเป็นแบบเดิม)
4. **ล็อกอินใหม่** (การกู้คืนจบ session ทุกคน) แล้ว **2. ไฟล์ภาพและเอกสาร**: เลือก `uploads.tar.gz` → อัปโหลดและกู้คืน
5. ตรวจ: ข่าวแสดงพร้อมภาพ เอกสารเปิดได้ ปฏิทินและสมุดโทรศัพท์ครบ · ผลทุกครั้งอยู่ใน **ประวัติการใช้งาน**
6. ลบ `prsru.dump` และ `uploads.tar.gz` ทั้งบนเครื่องเดิมและคอมพิวเตอร์ (มีข้อมูลส่วนบุคคล)

### 4.2 ผ่าน SSH เครื่อง Coolify
บนเครื่องเดิม: `npm run backup` แล้วคัดลอกไฟล์ `.dump` ล่าสุดและโฟลเดอร์ `uploads/` มาที่เครื่อง Coolify จากนั้นบนเครื่อง Coolify (SSH):
```sh
docker ps --format '{{.Names}}' | grep -E '^(db|app)-'      # ชื่อ container จริง (มีรหัสของ Coolify ต่อท้าย)
docker exec -i db-xxxx pg_restore -U prsru -d prsru --clean --if-exists --no-owner --exit-on-error < prsru-ปปปปดดวว-ชชนน.dump
docker cp uploads/. app-xxxx:/app/uploads/
docker exec -u 0 app-xxxx chown -R 1000:1000 /app/uploads
```
แล้ว Restart แอปใน Coolify

## 5. สำรองข้อมูล
`server/backup.mjs` เรียกคำสั่ง `docker` จากเครื่อง จึงไม่ใช้ใน Coolify ให้ตั้งแทนดังนี้:
1. **ฐานข้อมูลทุกคืน**: แอป → **Scheduled Tasks** → เพิ่มงาน · Container `db` · Frequency `30 2 * * *` · Command:
   ```sh
   sh -c 'mkdir -p /backups/db && pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /backups/db/prsru-$(date +%Y%m%d-%H%M).dump && find /backups/db -name "*.dump" -mtime +30 -delete'
   ```
2. **สำเนานอกเครื่อง** (ฐานข้อมูล + ไฟล์อัปโหลด) ไป Google Drive ของบัญชีหน่วยงาน ทำในหน้าเว็บ Coolify ทั้งหมด ไม่ต้อง SSH ใช้ container `offsite` (rclone) ที่อ่าน volume ได้อย่างเดียว
   1. ขอ token หนึ่งครั้งบนคอมพิวเตอร์ของตัวเอง: ดาวน์โหลด rclone จาก rclone.org/downloads แล้วรัน `rclone authorize "drive" "drive.file"` → เบราว์เซอร์เปิด → ล็อกอินบัญชี @sru.ac.th ของหน่วยงาน (ไม่ใช่บัญชีส่วนตัว) → คัดลอกข้อความ `{"access_token":...}` ทั้งก้อนที่ขึ้นใน terminal
   2. Environment Variables: `RCLONE_DRIVE_TOKEN` = ข้อความจากข้อ 1 (ติ๊ก **Is Secret**) · ถ้าจะเก็บใน Shared drive ของหน่วยงาน ใส่ `RCLONE_DRIVE_SHARED_ID` = รหัสท้าย URL ของ Shared drive นั้น (ไม่ใส่ = My Drive ของบัญชีที่ล็อกอิน) แล้ว Deploy
   3. Scheduled Tasks → เพิ่มงาน · Container `offsite` · Frequency `30 3 * * *` · Command:
      ```sh
      sh -c 'rclone sync /backups/db sru:prsru/db && rclone copy /uploads sru:prsru/uploads'
      ```
      `sync` ทำให้ปลายทางเก็บฐานข้อมูลย้อนหลัง 30 วันเท่าต้นทาง · `copy` ไม่ลบไฟล์อัปโหลดที่ปลายทาง แม้ต้นทางถูกลบ
   4. ทดสอบ: กด **Execute Now** ที่งานนี้ แล้วเปิด Google Drive ต้องเห็นโฟลเดอร์ `prsru/db` และ `prsru/uploads` (ครั้งแรกนาน เพราะส่งไฟล์อัปโหลดทั้งหมด)
   - token ใช้ได้เรื่อย ๆ จนกว่าจะเปลี่ยนรหัสผ่านหรือถอนสิทธิ์ที่ myaccount.google.com → Security ถ้างานเริ่มล้มเหลว ทำข้อ 1–2 ใหม่
   - ถ้า Google Workspace ของมหาวิทยาลัยบล็อกแอป rclone (ข้อ 1 ขึ้น "access blocked") ต้องขอ IT อนุญาต
   - โฟลเดอร์นี้มีข้อมูลส่วนบุคคล แชร์ให้เฉพาะผู้ดูแลระบบ
3. **ทดลองกู้คืนเดือนละครั้ง**: กู้ไฟล์ `.dump` ล่าสุดเข้าฐานชั่วคราวตามหัวข้อ "กู้คืนจริง" ใน `ops/BACKUP.md` แล้วลบทิ้ง

หน้า `chanon.html#backups` จะยังไม่แสดงสถานะ เพราะงานนี้ไม่ได้เขียน `status.json`

## 6. หน้าปิดปรับปรุง
proxy ของ Coolify ไม่แสดง `maintenance.html` ให้เอง ระหว่าง deploy เว็บจะหยุดช่วงสั้น ๆ ตอนสลับ container ควร deploy นอกเวลาทำงาน
