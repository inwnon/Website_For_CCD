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
ข้อมูลบนเครื่องใหม่จะถูก**แทนที่ทั้งหมด** ทำนอกเวลาทำงาน ข้อมูลที่เพิ่มบนเครื่องเดิมหลังข้อ 1 จะไม่ตามมา

### 4.1 ไม่มี SSH เข้าเครื่อง Coolify: ผ่าน Google Drive
ต้องตั้ง `RCLONE_DRIVE_TOKEN` (และ `RCLONE_DRIVE_SHARED_ID` ถ้าใช้) ตามข้อ 5.2 ข้อย่อย 1–2 ให้เสร็จก่อน container `restore` ใช้ค่าชุดเดียวกัน

1. **บนเครื่องเดิม (Hostinger, SSH)** สำรองแล้วส่งขึ้น Drive ตรงจากเซิร์ฟเวอร์ ไม่ต้องผ่านคอมพิวเตอร์ตัวเอง:
   ```sh
   cd /srv/prsru
   docker compose exec -T db pg_dump -U prsru -d prsru -Fc > prsru.dump
   read -rs TOKEN    # วางข้อความ token ชุดเดียวกับ RCLONE_DRIVE_TOKEN แล้วกด Enter (ไม่ขึ้นบนจอและไม่ค้างใน history)
   rc() { docker run --rm -v /srv/prsru:/data:ro -e RCLONE_CONFIG_SRU_TYPE=drive -e RCLONE_CONFIG_SRU_SCOPE=drive.file \
     -e RCLONE_CONFIG_SRU_TOKEN="$TOKEN" -e RCLONE_CONFIG_SRU_TEAM_DRIVE="" rclone/rclone:1.68.2 "$@"; }
   rc copy /data/prsru.dump sru:prsru/restore/ --progress
   rc copy /data/uploads sru:prsru/restore/uploads --progress
   rc size sru:prsru/restore    # จำนวนไฟล์และขนาด ไว้เทียบกับข้อ 2
   ```
   ถ้าใช้ Shared drive ใส่รหัสเดียวกับ `RCLONE_DRIVE_SHARED_ID` ใน `RCLONE_CONFIG_SRU_TEAM_DRIVE=""` ด้วย
2. **Coolify → Terminal → container `restore`** ดึงลงมา แล้วมอบไฟล์ให้ผู้ใช้ของแอป:
   ```sh
   rclone copy sru:prsru/restore/prsru.dump /backups/restore/ --progress
   rclone copy sru:prsru/restore/uploads /uploads --progress
   chown -R 1000:1000 /uploads && ls -l /backups/restore && du -sh /uploads
   ```
3. **Coolify → Terminal → container `db`** กู้ฐานข้อมูล:
   ```sh
   pg_restore -U prsru -d prsru --clean --if-exists --no-owner --exit-on-error /backups/restore/prsru.dump && echo RESTORE-OK
   ```
4. **Restart** แอปใน Coolify (migration ที่ใหม่กว่าจะรันเอง) แล้วตรวจ: ข่าวแสดงพร้อมภาพ เอกสารเปิดได้ ปฏิทินและสมุดโทรศัพท์ครบ
5. **ลบของชั่วคราว** (มีข้อมูลส่วนบุคคล): Terminal → `restore`: `rclone purge sru:prsru/restore && rm -rf /backups/restore` · บน Hostinger: `rm /srv/prsru/prsru.dump` แล้วลบ service `restore` ออกจาก `docker-compose.coolify.yml` (PR แยก) และ Deploy

### 4.2 มี SSH เข้าเครื่อง Coolify
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
