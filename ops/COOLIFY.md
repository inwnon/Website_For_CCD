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

`NODE_ENV=production` และ `ALLOW_DEV_LOGIN=0` ตั้งไว้ในไฟล์แล้ว แอปจะไม่ยอมเริ่มถ้าค่าข้างบนไม่ปลอดภัย (ดู log ของ `app`)

## 3. Deploy และผู้ดูแลคนแรก
1. กด **Deploy** — build image แล้วรัน migration ให้เองทุกครั้งที่แอปเริ่ม
2. เพิ่มแอดมินคนแรก: Coolify → **Terminal** → container `db`:
   ```sh
   psql -U prsru -d prsru -c "insert into pr_team (email, role) values ('ชื่อ@sru.ac.th', 'admin')"
   ```
3. อัปเดตเวอร์ชัน: merge เข้า `main` แล้วกด Deploy (หรือเปิด Auto Deploy ใน Coolify)

## 4. ย้ายข้อมูลจากเครื่องเดิม (ถ้าต้องการ)
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
2. **สำเนานอกเครื่อง** (ฐานข้อมูล + ไฟล์อัปโหลด): cron บนเครื่อง host คัดลอกโฟลเดอร์ของ volume `backups` และ `uploads` (ดูตำแหน่งด้วย `docker volume inspect`) ไปที่เก็บอื่นด้วย `rsync` เช่นเดียวกับ `BACKUP_OFFSITE_CMD` ใน `ops/BACKUP.md`
3. **ทดลองกู้คืนเดือนละครั้ง**: กู้ไฟล์ `.dump` ล่าสุดเข้าฐานชั่วคราวตามหัวข้อ "กู้คืนจริง" ใน `ops/BACKUP.md` แล้วลบทิ้ง

หน้า `chanon.html#backups` จะยังไม่แสดงสถานะ เพราะงานนี้ไม่ได้เขียน `status.json`

## 6. หน้าปิดปรับปรุง
proxy ของ Coolify ไม่แสดง `maintenance.html` ให้เอง ระหว่าง deploy เว็บจะหยุดช่วงสั้น ๆ ตอนสลับ container ควร deploy นอกเวลาทำงาน
