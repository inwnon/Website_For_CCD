// Usage history (ประวัติการใช้งาน): one row for every change made in the back office.
// audit(db, user, action, target, summary, details) — db is a transaction client or the pool,
// so the history row commits or rolls back together with the change it describes.
import { pool } from './db.mjs';

export async function audit(db, user, action, target, summary, details = {}) {
  await (db || pool).query(
    'insert into audit_log (actor_id, actor_email, action, target, summary, details) values ($1, $2, $3, $4, $5, $6)',
    [user?.id ?? null, user?.email ?? null, action, target ?? null, summary, JSON.stringify(details)],
  );
}

// Action names → Thai labels for the history filter on admin.html
export const ACTIONS = {
  'submission.status': 'เปลี่ยนสถานะงาน',
  'submission.message': 'ตอบข้อความผู้ส่ง',
  'submission.publish': 'เผยแพร่งาน',
  'submission.unpublish': 'ยกเลิกการเผยแพร่',
  'submission.edit': 'แก้ไขงานก่อนเผยแพร่',
  'news.import': 'นำเข้าข่าวย้อนหลัง',
  'news.update': 'แก้ไขข่าว',
  'news.feature': 'ข่าวเด่น',
  'news.withdraw': 'ถอนข่าว',
  'news.restore': 'คืนข่าว',
  'news.delete': 'ลบข่าว',
  'news.related': 'ข่าวที่เกี่ยวข้อง',
  'collection.create': 'สร้างอัลบั้มข่าว',
  'collection.update': 'แก้ไขอัลบั้มข่าว',
  'collection.delete': 'ลบอัลบั้มข่าว',
  'event.create': 'สร้างกิจกรรมในปฏิทิน',
  'event.update': 'แก้ไขกิจกรรมในปฏิทิน',
  'event.cancel': 'ยกเลิกกิจกรรมในปฏิทิน',
  'phonebook.create': 'เพิ่มหมายเลขในสมุดโทรศัพท์',
  'phonebook.update': 'แก้ไขหมายเลขในสมุดโทรศัพท์',
  'phonebook.delete': 'ลบหมายเลขจากสมุดโทรศัพท์',
  'role.set': 'กำหนดบทบาท',
  'role.remove': 'ยกเลิกบทบาท',
  'role.switch': 'สลับบทบาท (ผู้พัฒนาระบบ)',
  'settings.update': 'ตั้งค่าระบบ',
  // เล่มสรุปข่าว (removed): kept for the history it left
  'digest.update': 'จัดเล่มสรุปข่าว (ยกเลิกแล้ว)',
  'digest.publish': 'เผยแพร่เล่มสรุปข่าว (ยกเลิกแล้ว)',
  'digest.unpublish': 'ถอนเล่มสรุปข่าว (ยกเลิกแล้ว)',
  'digest.reset': 'ล้างการจัดเล่ม',
  'digest.file': 'ไฟล์ปก / PDF ของเล่ม',
  'mail.test': 'ส่งอีเมลทดสอบ',
  'privacy.erase': 'ลบข้อมูลส่วนบุคคล',
  'privacy.reject': 'ไม่ลบข้อมูลตามคำขอ',
};
