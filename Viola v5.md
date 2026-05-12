# Viola v5

لا نعمل Deploy لكل نقطة لوحدها. نجمع التعديلات ونختبرها محليًا، وبعدها نعمل Deploy واحد.

## 1. مشكلة Timeout بعد 30 ثانية

- المشكلة ظهرت عند الضغط على زر `Make Telegraph shipment` لأوردر معمول له بوليصة و Sales Order قبل كده.
- Netlify Function لها حد وقت حوالي 30 ثانية، ولو الطلب طول بيظهر خطأ `Sandbox.Timeout`.
- السبب الحالي إن الكود كان يعيد تشغيل خطوات Odoo الثقيلة حتى لو الأوردر مربوط بالفعل:
  - فحص/إنشاء Sales Order.
  - تصنيع وتجهيز مخزون.
  - Validate للدليفري.
- الحل المطلوب:
  - لو البوليصة موجودة و Odoo Sales Order موجود، الزر يرجع بسرعة بدون إعادة تشغيل Odoo.
  - يرجع للمستخدم إن الأوردر موجود بالفعل مع رقم البوليصة و Sales Order.
  - لا يتم تشغيل التصنيع/المخزون مرة ثانية إلا لو فيه نقص واضح في السجل أو Retry مقصود.
- تم تطبيق تعديل محلي لهذا السلوك، ويحتاج Deploy حتى يظهر على اللايف.

## 2. مشكلة Fulfilled بدون Tracking

- المشكلة ظهرت في Shopify لما الأوردر يكون `Fulfilled` لكن لا يظهر عليه `Tracking added`.
- السبب إن Shopify fulfillment موجود، لكن `trackingInfo` فاضي.
- الكود الحالي لما يلاقي الأوردر `already-fulfilled` يتوقف، وبالتالي لا يضيف رقم البوليصة على الـ fulfillment الموجود.
- مثال تم إصلاحه يدويًا:
  - Shopify order: `#1801`
  - Telegraph shipment: `VI0000295`
  - Telegraph shipment id: `8882472`
  - Odoo Sales Order: `S14318`
- هذا لا يمنع تحديثات شركة الشحن، لأن التحديث يعتمد على سجل الداتا بيز عندنا وفيه رقم البوليصة و id الشحنة.
- لكنه يسبب مشكلة تشغيلية داخل Shopify لأن التتبع لا يظهر للموظف.
- الحل المطلوب:
  - لو الأوردر `Fulfilled` بالفعل لكن `trackingInfo` فاضي، نحدث الـ fulfillment الموجود برقم البوليصة ورابطها.
  - نستخدم Telegraph كـ company.
  - لا نعمل fulfillment جديد لو القديم مغلق، فقط نعمل update للـ tracking.
  - لو tracking موجود بالفعل بنفس رقم البوليصة، نعتبر العملية ناجحة ونرجع بسرعة.

## المطلوب قبل Deploy v5

- اختبار Bulk Make Odoo Sales Orders مرتين بسرعة لنفس الأوردرات للتأكد من عدم إنشاء تكرارات.
- اختبار أوردر قديم عنده بوليصة و Odoo Sales Order للتأكد أنه لا يدخل في Timeout.
- اختبار أوردر fulfilled بدون tracking للتأكد أن الكود يضيف tracking على الـ fulfillment الموجود.
- اختبار أوردر جديد كامل للتأكد أن المسار ما زال يعمل:
  - إنشاء بوليصة Telegraph.
  - إنشاء Sales Order في Odoo.
  - تجهيز التصنيع والمخزون.
  - تأكيد الدليفري بعد إنشاء البوليصة.
- بعدها نعمل Deploy واحد لفيولا.

## 3. ثغرة تكرار Odoo Sales Order في الـ Bulk

- المشكلة ظهرت لما Bulk action عمل أكثر من Sales Order لنفس Shopify order.
- أمثلة فعلية:
  - `#1684` اتكرر بين `S14425` و `S14426`.
  - `#1689` اتكرر بين `S14427` و `S14428`.
  - `#1691` اتكرر بين `S14430` و `S14431` و `S14432`.
- السبب أن أكثر من عملية ممكن تبدأ قريب من بعض:
  - كل عملية تعمل Search في Odoo قبل ما العملية الأولى تكتب `odooSaleOrderId` في الداتا بيز.
  - كل عملية تشوف أن مفيش Sales Order، فتعمل واحد جديد.
  - في الآخر الداتا بيز تمسك آخر Sales Order فقط، لكن النسخ القديمة تفضل موجودة في Odoo.
- الحل الذي تم تطبيقه محليًا:
  - قبل إنشاء Sales Order، النظام يعمل claim على سجل Shopify order في الداتا بيز بحالة `sales-order-creating`.
  - لو عملية ثانية دخلت لنفس Shopify order، لا تنشئ Sales Order جديد.
  - العملية الثانية تنتظر لثواني وتعيد قراءة الداتا بيز و Odoo.
  - إذا وجدت Sales Order أنشأته العملية الأولى، تستخدمه وترجع بدون إنشاء نسخة ثانية.
  - بعد أخذ القفل، النظام يعيد البحث في Odoo مرة أخرى مباشرة قبل الإنشاء لتقليل أي race condition.
- هذا التعديل جاهز محليًا ونجح في الـ build، ويحتاج Deploy ضمن v5.

## 4. شاشة بيضاء بعد Make Odoo Sales Order

- المشكلة ظهرت عند عمل `Make Odoo Sales Order` لأوردر واحد مثل `#1657`.
- النظام أنشأ Sales Order فعليًا في Odoo:
  - Shopify order: `#1657`
  - Odoo Sales Order: `S14433`
- لكن الصفحة فضلت بيضاء أو واقفة لأن الطلب دخل بعد الإنشاء في خطوات تصنيع ومخزون ثقيلة داخل نفس Netlify request.
- هذه الخطوات ممكن تتعدى حد الـ 30 ثانية أو تقف في منتصف الطريق، فيظهر للمستخدم كأن العملية فشلت رغم أن جزء منها اتعمل.
- الحل الذي تم تطبيقه محليًا:
  - زر `Make Odoo Sales Order` أصبح يعمل Sales Order فقط ويرجع بسرعة.
  - لا يتم تشغيل تجهيز التصنيع والمخزون داخل نفس زر إنشاء الـ Sales Order.
  - تجهيز التصنيع والمخزون يظل في مسار `Make Telegraph shipment` أو في مسار منفصل/Retry واضح، حتى لا يحصل partial state بدون رسالة.
- تم أيضًا إصلاح التعامل مع `Consumption Warning`:
  - بدل استخدام `Confirm` الذي قد يقبل استهلاك صفر.
  - الكود يستخدم `action_set_qty`، وهو نفس معنى زر `Set Quantities & Validate`.
  - هذا يجعل Odoo يستهلك الكميات المتوقعة ثم يغلق الـ MO بشكل صحيح.
- في `#1657` تم استكمال التصنيع يدويًا بعد الفحص:
  - `WH/MO/247635` done.
  - `WH/MO/247636` done.
  - Child MOs `WH/MO/247638` و `WH/MO/247639` done.
  - `WH/PICK/14804` done.
  - `WH/OUT/14512` assigned وجاهز للخطوة التالية.
- نفس النمط ظهر مرة أخرى في `#1663`:
  - Odoo Sales Order اتعمل: `S14451`.
  - الصفحة وقفت لأن التصنيع دخل في child MOs متداخلة للـ wallet والـ gift box.
  - تم استكماله يدويًا:
    - `WH/MO/247713`, `WH/MO/247714`, `WH/MO/247715`, `WH/MO/247716`, `WH/MO/247717` كلها done.
    - `WH/PICK/14822` done.
    - `WH/OUT/14530` assigned.
  - هذا ليس bug جديد منفصل، لكنه تأكيد أن زر `Make Odoo Sales Order` لا يجب أن يشغل تجهيز التصنيع داخل نفس الطلب.

## 5. إصلاح Sync حالة Telegraph إلى Shopify وOdoo

- المشكلة:
  - Telegraph حدثت حالات شحنات كثيرة بالفعل، لكن Shopify وOdoo لم يسمعوا التحديثات بشكل موثوق.
  - السبب الأساسي أن `sync-open-shipments` كان يعالج كل الشحنات المفتوحة مرة واحدة، وده ممكن يتجاوز حد Netlify 30 ثانية.
  - السبب المحاسبي الأخطر أن Odoo sync كان ممكن ينشئ فاتورة جديدة لو سجل الـ integration لا يحتوي `odooInvoiceId`، حتى لو Odoo فيه فاتورة موجودة بالفعل.

- التعديل الذي تم تطبيقه محليًا:
  - إضافة إعداد `SYNC_OPEN_SHIPMENTS_BATCH_SIZE` بقيمة افتراضية `10`.
  - `sync-open-shipments` يعالج دفعة صغيرة فقط ويرجع `processed` و `failed`.
  - أي فشل داخل دفعة sync يتحفظ في `FailedPayload` ولا يوقف باقي الشحنات.
  - إضافة script آمن:
    - `npm run sync:dry-run -- --limit=10`
    - يعرض حالة Telegraph الحقيقية، وما الذي سيحدث في Shopify وOdoo بدون كتابة.

- Odoo collected sync أصبح idempotent:
  - يبحث أولًا عن فاتورة موجودة في Sales Order أو بنفس `invoice_origin`.
  - لو الفاتورة `draft` يعمل لها `post`.
  - لو الفاتورة `paid` يسجلها في جدول الـ integration كـ `paid-existing` ولا يعمل دفع جديد.
  - لو الفاتورة `not_paid` يدفع المتبقي فقط، ولا يدفع أكثر من `amount_residual`.
  - لو لا توجد فاتورة، ينشئ فاتورة جديدة من Odoo invoice wizard ثم يعمل `post` ويدفعها.

- Returned sync أصبح أكثر أمانًا:
  - يبحث عن Bill موجود بنفس reference قبل إنشاء Bill جديد.
  - لو Bill موجود ومدفوع، يسجله فقط في integration.
  - لو Bill يحتاج دفع، يدفع المتبقي فقط.

- Shopify status أصبح أنظف:
  - يتم تحديث metafields للحالة والتحصيل.
  - يتم حذف status tags القديمة قبل إضافة tags الجديدة.
  - هذا يمنع ظهور tags متعارضة مثل `accurate-bmt` مع `accurate-delivered`.

- اختبار حقيقي تم تنفيذه بنجاح:
  - Shopify order: `#1743`
  - Telegraph shipment: `VI0000200`
  - Telegraph live status: `DTR / تم التسليم`
  - Collection status: `collected`
  - Shopify أصبح عليه:
    - `shipment_status = تم التسليم`
    - `collection_status = collected`
    - tags: `accurate`, `accurate-delivered`, `accurate-collected`
  - Odoo استخدم الفاتورة الموجودة:
    - Sales Order: `S14489`
    - Invoice: `INV/2026/03769`
    - State: `posted`
    - Payment: `paid`
  - لم يتم إنشاء فاتورة مكررة ولم يتم تسجيل دفع مكرر.

- اختبارات تمت:
  - `npm run build` نجح.
  - `npm run test:telegraph-scenarios` نجح.
  - `npm run sync:dry-run -- --limit=40` نجح.

- ملاحظة قبل Deploy:
  - يجب التأكد أن فولدر Viola مربوط على Netlify site الصحيح `viola-telegraph.netlify.app`.
  - لا يتم الخلط مع Loomlac.
  - بعد deploy، نبدأ بتشغيل batch صغير ومراقبة أول دفعة قبل ترك scheduled sync يعمل تلقائيًا.

## 6. ثغرة Payment Review عند التسليم مع مبلغ علينا

- السيناريو:
  - شركة الشحن ترجع الحالة `DTR / تم التسليم`.
  - في نفس الوقت يكون `customerDue` بالسالب، مثال `-67`.
  - معنى ذلك محاسبيًا أن الأوردر محتاج مراجعة، لأن التسليم حصل لكن فيه مبلغ/رسوم علينا أو تحصيل غير طبيعي.

- نتيجة الاختبار المحلي الحالي:
  - input:
    - `statusCode = DTR`
    - `collected = true`
    - `customerDue = -67`
  - الكود الحالي يرجع:
    - `collectionStatus = collected`
    - tags: `accurate-delivered`, `accurate-collected`
  - دالة حساب الرسوم تفهم أن علينا `67`، لكن status mapper لا يحول الحالة إلى `payment-review`.

- الخطر:
  - Shopify لن يظهر عليه `payment-review`.
  - Odoo لن يظهر عليه marker قابل للبحث باسم `payment-review`.
  - مسار Odoo collected ممكن يتعامل مع الأوردر كأنه تحصيل عادي، وهذا غير آمن محاسبيًا.

- الحل المطلوب قبل Deploy:
  - إضافة حالة `payment-review` عندما:
    - `statusCode = DTR`
    - و `customerDue < 0` أو `returningDueFees > 0` في سيناريو تسليم غير طبيعي.
  - Shopify:
    - `collection_status = payment-review`
    - tags تشمل `accurate-payment-review`
    - لا يتم اعتباره `accurate-collected` إلا بعد مراجعة المحاسب.
  - Odoo:
    - لا يتم تسجيل payment تلقائيًا في هذا السيناريو.
    - يتم تحديث سجل الـ integration بحالة `payment-review`.
    - يجب أن يكون قابلًا للبحث بـ `payment-review` من خلال reference أو note/field واضح.
  - بعد المراجعة اليدوية فقط يتم تشغيل مسار الدفع أو تسوية المصروف.

- اختبار مطلوب بعد التعديل:
  - `DTR + customerDue = -67` يجب أن ينتج `payment-review`.
  - لا يتم إنشاء payment في Odoo تلقائيًا.
  - Shopify يظهر عليه tag/metafield `payment-review`.
  - البحث في Shopify وOdoo بكلمة `payment-review` يوصل للأوردر.

- تم تطبيق الإصلاح محليًا:
  - `DTR + customerDue < 0` ينتج:
    - `collectionStatus = payment-review`
    - tags: `accurate-delivered`, `accurate-payment-review`
  - مسار Odoo لا يسجل payment تلقائيًا عند `payment-review`.
  - يتم تسجيل payload باسم `payment-review` للمراجعة.
  - تم تحديث اختبار السيناريوهات وأصبح عددها `13`.

## 7. نتائج Pre-Deploy Audit قوي

- تم تشغيل:
  - `npm run test:telegraph-scenarios` ونجح.
  - `npm run build` ونجح عند تشغيله منفردًا.
  - `npm run sync:dry-run -- --limit=80` ونجح.

- ملاحظة تشغيل:
  - لا يجب تشغيل `npm run build` بالتوازي مع أي script يستخدم Prisma.
  - عند تشغيل build و dry-run في نفس اللحظة ظهر خطأ Windows `EPERM` بسبب قفل Prisma DLL، وليس خطأ TypeScript.

- Audit live من Telegraph على `124` شحنة:
  - `22` شحنة: `DTR / collected`.
  - `18` شحنة: `DTR / delivered-not-collected`.
  - `3` شحنات returned تقريبًا.
  - `1` شحنة عندنا لكن Telegraph لا يجدها:
    - Shopify order: `#1871`
    - Shipment: `VI0000305`
    - id: `8883169`
  - `122` سجل في DB حالته أقدم من Telegraph live، وهذا يؤكد أن scheduled sync كان لا يلحق التحديثات.

- ثغرة تم إصلاحها محليًا بعد الـ audit:
  - لو Telegraph رجع `shipment not found` أثناء sync، النظام لن يظل يفشل كل ساعة.
  - سيتم مسح `accurateShipmentId` و `accurateShipmentCode` من سجل الشحنة وتعليمها `DELETED_ON_TELEGRAPH`.
  - هذا يمنع البوليصة المحذوفة من تعطيل batch sync كل مرة.

- ملاحظات محاسبية من الـ audit:
  - يوجد `21` شحنة collected عندها Odoo Sales Order لكن سجل integration لا يحتوي invoice id.
  - الإصلاح الجديد لـ Odoo idempotency يعالج هذا عند أول sync:
    - يبحث في Odoo عن الفاتورة الموجودة.
    - يستخدمها بدل إنشاء فاتورة جديدة.
  - يوجد `18` شحنة delivered-not-collected؛ هذه لا يجب أن تعمل payment تلقائيًا حتى تتغير حالة التحصيل.

- Blocker قبل deploy:
  - `netlify functions:list` يرجع:
    - `The project this folder is linked to can't be found`
  - `shopify app info` يرجع:
    - `You are not a member of the requested organization`
  - معنى ذلك أن الحساب الحالي على الجهاز ليس مربوطًا صح بـ Viola Netlify/Shopify app.
  - يجب تسجيل الدخول للحساب الصحيح قبل أي deploy، حتى لا نرفع على Loomlac أو project غلط.
