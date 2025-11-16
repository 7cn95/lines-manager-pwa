const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const webPush = require('web-push');
const fs = require('fs');

const app = express();
const db = new Database('data.db');

// VAPID keys (ضع مفاتيحك هنا أو في env)
const VAPID_PUBLIC_KEY = 'BDU7qjby3RjTS4nbt3Ego6wC2xFoxH4v6nRnylq2gCzGEHkD7HSkLkrTESX4mFBuWue1Bu6aLj4gjgzfP1p0A';
const VAPID_PRIVATE_KEY = 'hHy3T9WyEz4bC8hQdJp0uxTmYq1iIx2EVQFsnmJvBMo';

if (VAPID_PUBLIC_KEY === 'PUT_YOUR_PUBLIC_KEY_HERE') {
  console.warn('تحذير: لم تضبط مفاتيح VAPID بعد. Push Notifications لن تعمل حتى تضبطها.');
}

webPush.setVapidDetails(
  'mailto:you@example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// middleware
app.use(morgan('dev'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: 'CHANGE_THIS_SECRET_KEY',
    resave: false,
    saveUninitialized: false
  })
);
app.use(flash());

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.error = req.flash('error');
  res.locals.success = req.flash('success');
  next();
});

const upload = multer({ dest: 'uploads/' });

// Helpers
function classifyStatus(expiryDateStr) {
  if (!expiryDateStr) return 'UNKNOWN';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expiry = new Date(expiryDateStr);
  expiry.setHours(0, 0, 0, 0);

  if (isNaN(expiry.getTime())) return 'UNKNOWN';

  const diffMs = expiry - today;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays < 0) return 'EXPIRED';
  if (diffDays <= 7) return 'EXPIRING_SOON';
  return 'ACTIVE';
}

function renewForOneMonth(expiryDateStr) {
  const d = new Date(expiryDateStr);
  if (isNaN(d.getTime())) {
    const now = new Date();
    now.setMonth(now.getMonth() + 1);
    return now.toISOString().slice(0, 10);
  }
  const originalDay = d.getDate();
  d.setMonth(d.getMonth() + 1);
  if (d.getDate() < originalDay) {
    d.setDate(0);
  }
  return d.toISOString().slice(0, 10);
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// Push subscriptions helpers
function saveSubscription(subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys) return;
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (existing) return;
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, auth, p256dh)
     VALUES (?, ?, ?)`
  ).run(endpoint, keys.auth, keys.p256dh);
}

function getAllSubscriptions() {
  return db.prepare('SELECT endpoint, auth, p256dh FROM push_subscriptions').all();
}

function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

// ===== Push API =====
app.get('/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/push/subscribe', (req, res) => {
  const subscription = req.body;
  try {
    saveSubscription(subscription);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Error saving subscription', err);
    res.status(500).json({ success: false });
  }
});

// ===== Public page =====
app.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT id, person_name, phone_number, job_title, workplace, package_amount, expiry_date
    FROM lines
    ORDER BY datetime(expiry_date) ASC
  `).all();

  const lines = rows.map(r => ({
    ...r,
    status: classifyStatus(r.expiry_date)
  }));

  const stats = {
    total: lines.length,
    active: lines.filter(l => l.status === 'ACTIVE').length,
    soon: lines.filter(l => l.status === 'EXPIRING_SOON').length,
    expired: lines.filter(l => l.status === 'EXPIRED').length
  };

  res.render('public_list', { title: 'الخطوط الحالية', lines, stats });
});

// ===== Auth =====
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  res.render('login', { title: 'تسجيل الدخول' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    req.flash('error', 'بيانات الدخول غير صحيحة.');
    return res.redirect('/login');
  }
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    req.flash('error', 'بيانات الدخول غير صحيحة.');
    return res.redirect('/login');
  }
  req.session.user = { id: user.id, username: user.username };
  res.redirect('/admin');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ===== Admin dashboard =====
app.get('/admin', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, person_name, phone_number, job_title, workplace, package_amount, expiry_date, created_at
    FROM lines
    ORDER BY datetime(expiry_date) ASC
  `).all();

  const lines = rows.map(r => ({
    ...r,
    status: classifyStatus(r.expiry_date)
  }));

  const stats = {
    total: lines.length,
    active: lines.filter(l => l.status === 'ACTIVE').length,
    soon: lines.filter(l => l.status === 'EXPIRING_SOON').length,
    expired: lines.filter(l => l.status === 'EXPIRED').length
  };

  res.render('admin_list', { title: 'لوحة التحكم', lines, stats });
});

// Notify expiring/expired
app.post('/admin/notify-expiring', requireAuth, async (req, res) => {
  const rows = db.prepare(`
    SELECT id, person_name, phone_number, expiry_date
    FROM lines
  `).all();

  const lines = rows.map(r => ({
    ...r,
    status: classifyStatus(r.expiry_date)
  }));

  const soon = lines.filter(l => l.status === 'EXPIRING_SOON');
  const expired = lines.filter(l => l.status === 'EXPIRED');

  const soonCount = soon.length;
  const expiredCount = expired.length;

  if (!soonCount && !expiredCount) {
    req.flash('success', 'لا توجد خطوط منتهية أو قريبة الانتهاء لإرسال إشعارات عنها.');
    return res.redirect('/admin');
  }

  const payload = JSON.stringify({
    title: 'تنبيه انتهاء الباقات',
    body: `هناك ${soonCount} خط/خطوط ستنتهي خلال ٧ أيام و ${expiredCount} خط/خطوط منتهية.`,
    url: '/'
  });

  const subs = getAllSubscriptions();

  const sendPromises = subs.map(sub => {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { auth: sub.auth, p256dh: sub.p256dh }
    };
    return webPush.sendNotification(pushSub, payload)
      .catch(err => {
        console.error('Push error, removing subscription', err);
        removeSubscription(sub.endpoint);
      });
  });

  try {
    await Promise.all(sendPromises);
    req.flash('success', 'تم إرسال الإشعارات للاشتراكات المسجلة.');
  } catch (err) {
    console.error('Error sending notifications', err);
    req.flash('error', 'حدث خطأ أثناء إرسال الإشعارات.');
  }

  res.redirect('/admin');
});

// ===== CSV Import =====
app.get('/admin/import', requireAuth, (req, res) => {
  res.render('admin_import', { title: 'استيراد CSV' });
});

app.post('/admin/import', requireAuth, upload.single('csvfile'), (req, res) => {
  if (!req.file) {
    req.flash('error', 'لم يتم اختيار ملف.');
    return res.redirect('/admin/import');
  }

  const filePath = req.file.path;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    let inserted = 0;

    records.forEach(row => {
      const person_name = row.person_name || row['الاسم'] || '';
      const phone_number = row.phone_number || row['الرقم'] || '';
      const job_title = row.job_title || row['العنوان_الوظيفي'] || null;
      const workplace = row.workplace || row['مكان_العمل'] || null;
      const package_amount_raw = row.package_amount || row['مبلغ_الباقة'] || null;
      const expiry_date = row.expiry_date || row['تاريخ_الانتهاء'] || null;

      if (!person_name || !phone_number || !expiry_date) return;

      const package_amount = package_amount_raw
        ? Number(String(package_amount_raw).replace(/[^\d]/g, '')) || null
        : null;

      db.prepare(
        `INSERT INTO lines
          (person_name, phone_number, job_title, workplace, package_amount, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        person_name,
        phone_number,
        job_title,
        workplace,
        package_amount,
        expiry_date
      );
      inserted++;
    });

    req.flash('success', `تم استيراد ${inserted} خط.`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'فشل استيراد الملف. تأكد من الصيغة.');
  } finally {
    fs.unlink(filePath, () => {});
  }

  res.redirect('/admin');
});

// ===== CRUD Lines =====
app.get('/admin/lines/new', requireAuth, (req, res) => {
  res.render('admin_form', {
    title: 'إضافة خط جديد',
    mode: 'create',
    line: {
      person_name: '',
      phone_number: '',
      job_title: '',
      workplace: '',
      package_amount: '',
      expiry_date: ''
    }
  });
});

app.post('/admin/lines', requireAuth, (req, res) => {
  const {
    person_name,
    phone_number,
    job_title,
    workplace,
    package_amount,
    expiry_date
  } = req.body;

  if (!person_name || !phone_number || !expiry_date) {
    req.flash('error', 'الاسم، رقم الهاتف، وتاريخ الانتهاء حقول إلزامية.');
    return res.redirect('/admin/lines/new');
  }

  db.prepare(
    `INSERT INTO lines
      (person_name, phone_number, job_title, workplace, package_amount, expiry_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    person_name.trim(),
    phone_number.trim(),
    job_title ? job_title.trim() : null,
    workplace ? workplace.trim() : null,
    package_amount ? Number(package_amount) : null,
    expiry_date
  );

  req.flash('success', 'تم إضافة الخط بنجاح.');
  res.redirect('/admin');
});

app.get('/admin/lines/:id/edit', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT id, person_name, phone_number, job_title, workplace, package_amount, expiry_date
    FROM lines WHERE id = ?
  `).get(id);

  if (!row) {
    req.flash('error', 'الخط غير موجود.');
    return res.redirect('/admin');
  }

  res.render('admin_form', {
    title: 'تعديل خط',
    mode: 'edit',
    line: row
  });
});

app.post('/admin/lines/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const {
    person_name,
    phone_number,
    job_title,
    workplace,
    package_amount,
    expiry_date
  } = req.body;

  if (!person_name || !phone_number || !expiry_date) {
    req.flash('error', 'الاسم، رقم الهاتف، وتاريخ الانتهاء حقول إلزامية.');
    return res.redirect(`/admin/lines/${id}/edit`);
  }

  db.prepare(
    `UPDATE lines
     SET person_name = ?, phone_number = ?, job_title = ?, workplace = ?, package_amount = ?, expiry_date = ?
     WHERE id = ?`
  ).run(
    person_name.trim(),
    phone_number.trim(),
    job_title ? job_title.trim() : null,
    workplace ? workplace.trim() : null,
    package_amount ? Number(package_amount) : null,
    expiry_date,
    id
  );

  req.flash('success', 'تم تحديث بيانات الخط.');
  res.redirect('/admin');
});

app.post('/admin/lines/:id/renew', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT expiry_date FROM lines WHERE id = ?').get(id);

  if (!row) {
    req.flash('error', 'الخط غير موجود.');
    return res.redirect('/admin');
  }

  const newExpiry = renewForOneMonth(row.expiry_date);
  db.prepare('UPDATE lines SET expiry_date = ? WHERE id = ?').run(newExpiry, id);

  req.flash('success', 'تم تجديد الباقة لشهر إضافي.');
  res.redirect('/admin');
});

app.post('/admin/lines/:id/delete', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM lines WHERE id = ?').run(id);
  req.flash('success', 'تم حذف الخط.');
  res.redirect('/admin');
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});