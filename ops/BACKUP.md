# การสำรองข้อมูลและการกู้คืน คลังข่าว มรส.

| อะไร | เมื่อไร | เก็บนาน |
|---|---|---|
| ฐานข้อมูล (pg_dump) | ทุกคืน 02:30 น. | 30 วัน |
| ไฟล์ที่อัปโหลด (`uploads/`) แบบเพิ่มเติม | ทุกคืน 02:30 น. (ต่อจากฐานข้อมูล) | 30 วัน |
| สำเนานอกเครื่อง | ทุกคืน หลังสำรองในเครื่องสำเร็จ | ตามที่ปลายทางกำหนด |
| ทดลองกู้คืนจริง | วันที่ 1 ของทุกเดือน 04:00 น. | – |

ผลครั้งล่าสุดดูได้ที่ `chanon.html#backups` (หน้าตั้งค่าระบบ → สำรองข้อมูล) หน้านั้นจะเตือนเมื่อ
- ไม่ได้สำรองข้อมูลเกิน 26 ชั่วโมง หรือการสำรองครั้งล่าสุดไม่สำเร็จ
- ยังไม่ได้ตั้งสำเนานอกเครื่อง
- ไม่ได้ทดลองกู้คืนเกิน 35 วัน หรือการทดลองครั้งล่าสุดไม่ผ่าน

## สิ่งที่สคริปต์ทำ
**`npm run backup`** (`server/backup.mjs`)
1. `pg_dump` ฐานข้อมูลเป็น `BACKUP_DIR/db/prsru-ปปปปดดวว-ชชนน.dump` แล้วเปิดไฟล์ตรวจด้วย `pg_restore --list` และบันทึกจำนวนแถวของตารางหลักไว้ข้างกัน (`.dump.json`)
2. ไฟล์ใน `uploads/` (ยกเว้น `tmp/`) ไปไว้ที่ `BACKUP_DIR/media/ปปปป-ดด-วว/` ไฟล์ที่ไม่เปลี่ยนจากคืนก่อนจะเป็น hard link ไปยังไฟล์เดิม (ไม่กินที่เพิ่ม) แต่ละชุดมี `manifest.json` เก็บขนาดและ SHA-256 ของทุกไฟล์
3. ลบชุดที่เก่ากว่า `BACKUP_KEEP_DAYS` วัน
4. รัน `BACKUP_OFFSITE_CMD` เพื่อคัดลอกทั้ง `BACKUP_DIR` ออกนอกเครื่อง
5. เขียนผลลง `BACKUP_DIR/status.json` ถ้ามีขั้นใดล้มเหลวจะจบด้วย exit code 1

**`npm run backup:restore-test`** (`server/restore-test.mjs`)
1. กู้คืน dump ล่าสุดลง PostgreSQL ใหม่ที่ว่างเปล่า (container ชั่วคราว ลบทิ้งเมื่อเสร็จ ไม่แตะฐานข้อมูลจริง)
2. จำนวนแถวต้องตรงกับตอนสำรอง จำนวนตารางและ migration ต้องครบ
3. ไฟล์ทุกไฟล์ใน manifest ต้องมีอยู่และขนาดตรง สุ่ม 40 ไฟล์ตรวจ SHA-256 และไฟล์ทุกไฟล์ที่ฐานข้อมูลที่กู้คืนอ้างถึงต้องอยู่ในชุดสำรอง
4. เขียนผลลง `status.json` ถ้าไม่ผ่านจะจบด้วย exit code 1

สคริปต์ทั้งสองใช้แค่ Node.js (ไม่ต้อง `npm install`) และ Docker ของเครื่อง

## ตั้งค่าบนเซิร์ฟเวอร์ (Linux)
1. ติดตั้ง Node.js 22 บนเครื่อง (สคริปต์รันนอก container เพื่อเรียก `docker compose exec db pg_dump`)
2. ใน `.env` ของโปรเจกต์
   ```sh
   BACKUP_DIR=/srv/backups/prsru        # นอกโฟลเดอร์โปรเจกต์ ดิสก์เดียวกันทั้งโฟลเดอร์ (hard link)
   BACKUP_OFFSITE_CMD=rsync -aH --delete {dir}/ backup@nas.sru.ac.th:/backups/prsru/
   ```
   - ใช้ `rsync -aH` เพื่อให้ปลายทางเก็บ hard link ด้วย ไม่อย่างนั้นไฟล์ 30 ชุดจะกินที่เต็ม 30 เท่า
   - ถ้าใช้ rclone (เช่น Google Drive ของมหาวิทยาลัย) ปลายทางไม่รองรับ hard link ให้ส่งเฉพาะฐานข้อมูลและชุดไฟล์ล่าสุด เช่น
     `rclone sync {dir}/db sru-backup:prsru/db && rclone sync {dir}/media/$(date +%F) sru-backup:prsru/media-latest`
   - บัญชีที่ใช้ต้องตั้ง SSH key / rclone config ไว้ก่อน (ไม่ต้องใส่รหัสผ่านในคำสั่ง)
   - สำเนานอกเครื่องควรอยู่คนละอาคารหรือคนละระบบกับเซิร์ฟเวอร์ และจำกัดคนเข้าถึง เพราะมีข้อมูลส่วนบุคคล
3. ตั้งเวลา (`crontab -e` ของผู้ใช้ที่สั่ง docker ได้)
   ```cron
   CRON_TZ=Asia/Bangkok
   30 2 * * *  cd /srv/prsru && node --env-file=.env server/backup.mjs        >> /var/log/prsru-backup.log 2>&1
   0  4 1 * *  cd /srv/prsru && node --env-file=.env server/restore-test.mjs  >> /var/log/prsru-backup.log 2>&1
   ```
4. รันเองครั้งแรกทั้งสองคำสั่ง แล้วเปิด `chanon.html#backups` ต้องไม่มีคำเตือน

### Windows (Task Scheduler)
```bat
schtasks /Create /TN "prsru backup" /SC DAILY /ST 02:30 /TR "cmd /c cd /d C:\srv\prsru && node --env-file=.env server\backup.mjs >> C:\srv\logs\prsru-backup.log 2>&1"
schtasks /Create /TN "prsru restore test" /SC MONTHLY /D 1 /ST 04:00 /TR "cmd /c cd /d C:\srv\prsru && node --env-file=.env server\restore-test.mjs >> C:\srv\logs\prsru-backup.log 2>&1"
```
ตั้งให้ทำงานแม้ผู้ใช้ไม่ได้ล็อกอิน (Run whether user is logged on or not) และ Docker Desktop ต้องเปิดอยู่

## กู้คืนจริง (เมื่อข้อมูลเสียหาย)
ทำนอกเวลาใช้งาน แจ้งทีม PR ก่อน และ**ห้ามเริ่มจนกว่าจะสำรองสภาพปัจจุบันไว้หนึ่งชุด** (`npm run backup`) เผื่อต้องย้อนกลับ

1. เลือกชุดที่จะกู้ ดูรายการได้ที่ `BACKUP_DIR/db/` และ `BACKUP_DIR/media/` ถ้าเครื่องเสียทั้งเครื่อง ให้ดึงจากสำเนานอกเครื่องกลับมาก่อน
   ```sh
   rsync -aH backup@nas.sru.ac.th:/backups/prsru/ /srv/backups/prsru/
   ```
2. เปิดหน้าปิดปรับปรุงและหยุดแอป (ฐานข้อมูลยังเปิดอยู่)
   ```sh
   touch /srv/prsru/MAINTENANCE
   docker compose stop app
   ```
3. กู้ฐานข้อมูล (แทนที่ตารางเดิมทั้งหมด)
   ```sh
   docker compose exec -T db pg_restore -U prsru -d prsru --clean --if-exists --no-owner --exit-on-error \
     < /srv/backups/prsru/db/prsru-20261017-0230.dump
   ```
4. กู้ไฟล์ (ไม่เอา `manifest.json` มาด้วย)
   ```sh
   rsync -a --delete --exclude manifest.json --exclude tmp/ /srv/backups/prsru/media/2026-10-17/ /srv/prsru/uploads/
   ```
5. เปิดแอปและตรวจ
   ```sh
   docker compose --profile app up -d
   rm /srv/prsru/MAINTENANCE
   ```
   - เปิดหน้าแรก ข่าวล่าสุด ภาพในข่าว และ `pr.html` ว่าเห็นงานที่ส่งเข้ามาครบ
   - ข้อมูลหลังเวลาของชุดที่กู้จะหายไป แจ้งผู้ส่งงานช่วงนั้นให้ส่งใหม่
   - บันทึกว่ากู้เมื่อไร จากชุดไหน เพราะอะไร ไว้ในรายงานเหตุการณ์

กู้แค่บางส่วน (เช่น ข่าวที่ถูกลบผิด) ไม่ต้องกู้ทั้งฐาน ให้กู้ลงฐานชั่วคราวแล้วคัดลอกเฉพาะแถวที่ต้องการ:
```sh
docker compose exec db createdb -U prsru prsru_old
docker compose exec -T db pg_restore -U prsru -d prsru_old --no-owner < /srv/backups/prsru/db/prsru-20261017-0230.dump
# ... เปิดดูด้วย psql -d prsru_old แล้ว insert กลับทีละแถว
docker compose exec db dropdb -U prsru prsru_old
```
ประวัติการแก้ไขข่าวแต่ละครั้ง (`news_revisions`) ใช้ดูค่าก่อนแก้ได้โดยไม่ต้องกู้ข้อมูล (ปุ่ม "ประวัติ" ใน `pr-news.html`)
