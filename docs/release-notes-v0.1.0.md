# v0.1.0 的 Release 说明正文（六语言）

这份文件是 **GitHub Release 页面上那段说明的原文**，发版时整段贴进去即可。

写法上有一条硬约束：**它是一个项目的第一次公开发布，所以通篇不出现「新增」
「本版改动」「修复了…」这类措辞。** 没有上一版，"改动"这个词就没有参照物；
读到它的人是第一次听说这个项目，他要的是"这是什么、我该下哪个"，不是一份
他没见过的东西的差异列表。

六种语言的内容对齐，不是逐字直译——各自读起来都要像原文。

---

## English

Tessera is an encrypted vault for Windows. Files, passwords, notes, clipboard history and a
file manager all sit behind a single unlock, and nothing leaves your machine.

### Download

| File | For |
|---|---|
| `Tessera.Setup.exe` | The normal installer. Choose where it goes, get a Start-menu shortcut, uninstall from Apps & features. **Uninstalling does not delete your vault.** |
| `Tessera.exe` | Portable. Download and run — no registry writes, fine on a USB stick. |
| `Tessera-CrossDevice-0.1.0.apk` | The Android companion, for pairing a phone or tablet. Sideload it; it is not on Google Play. |

Both Windows builds check for their own updates and stay in their own format.

### What you get

- **Five ways to unlock, any one of them is enough** — password, email code, authenticator
  app, Windows Hello, recovery key. Biometrics start on their own everywhere a password
  would be asked for, picking face, fingerprint or iris depending on what your machine has.
- **A vault that holds more than files** — password manager with a built-in authenticator,
  clipboard history that keeps formatting, notes that open instantly at hundreds of
  megabytes, and a file manager whose copy/paste is faster than Explorer's.
- **Whole folders, encrypted into one file** — and opening one shows you what is inside
  without decrypting it first, so a 10 GB folder lists as fast as a small one. Extraction
  writes each file exactly once; nothing plaintext is ever staged on disk in between.
- **Cross-device sync over your own network** — copy text, rich text or images on the phone and
  paste on the PC; send files, folders and app packages to one or several selected devices. Four
  pairing paths, pause/resume/cancel controls, end-to-end encryption and no server in the middle.
  Android reads its clipboard while Tessera is in the foreground, as required by Android 10+.
- **Six languages** — English, 简体中文, Français, Español, Русский, العربية — switchable
  anywhere, including the login screen.

### First run

Windows will show "Windows protected your PC" the first time. That is SmartScreen reacting
to a self-signed certificate, not a virus warning: choose **More info → Run anyway**. It
happens once.

The setup wizard then walks you through a password, a recovery key and whichever of the
other unlock methods you want. **Write the recovery key down** — it is shown exactly once,
and it is the only way back in if you lose everything else.

Full walkthrough: [desktop guide](../docs/电脑端操作指南.md) ·
[Android guide](../docs/安卓端操作指南.md)

### Requirements

Windows 10 or 11, 64-bit. Android 8.0 or newer for the companion app.

---

## 简体中文

Tessera 是一个 Windows 上的加密保险库。文件、密码、笔记、剪贴板记录和一个文件管理器
共用一次解锁，所有数据都不离开这台机器。

### 下载哪个

| 文件 | 适合 |
|---|---|
| `Tessera.Setup.exe` | 常规安装。可选安装位置，有开始菜单快捷方式，能从「应用和功能」卸载。**卸载不会删除你的金库。** |
| `Tessera.exe` | 免安装。下载即用，不写注册表，可以放 U 盘里。 |
| `Tessera-CrossDevice-0.1.0.apk` | 安卓手机/平板端，用来和电脑配对。需要手动安装，没有上应用商店。 |

两个 Windows 版本各自检查更新，各更新各的形态。

### 里面有什么

- **五种解锁方式，任意一种都能进** —— 密码、邮箱验证码、验证器 App、Windows Hello、
  恢复密钥。所有要密码的地方都会自动发起生物识别，按这台机器实际有的传感器选人脸、
  指纹或虹膜。
- **装的不只是文件** —— 带验证器的密码管理、保留格式的剪贴板记录、几百 MB 也秒开的
  笔记、以及一个复制粘贴比资源管理器快的文件管理器。
- **整个文件夹加密成一个文件** —— 打开它时**不用先解密就能看到里面有什么**，10 GB 的
  文件夹和小文件夹一样快列出清单。解压时每个文件只写一遍，中途不会在磁盘上留下任何明文。
- **跨设备互传走你自己的局域网** —— 手机复制文字、富文本或图片，电脑直接粘贴；文件、文件夹和
  应用安装包可明确发给一台或多台设备。四种配对方式，暂停/继续/取消控制，端到端加密，中间没有
  任何服务器。Android 10 及以上受系统限制，只有 Tessera 在前台时才能读取剪贴板。
- **六种语言** —— English、简体中文、Français、Español、Русский、العربية，任何界面
  （包括登录页）都能切。

### 第一次打开

Windows 会弹「已保护你的电脑」。这是 SmartScreen 对自签名证书的反应，不是病毒警告：
点**更多信息 → 仍要运行**，只在第一次出现。

然后向导会带你设置密码、恢复密钥，以及你想用的其他解锁方式。**恢复密钥请务必抄下来**
—— 它只显示一次，也是其他方式全部失效之后唯一还能进去的路。

详细说明：[电脑端操作指南](../docs/电脑端操作指南.md) ·
[安卓端操作指南](../docs/安卓端操作指南.md)

### 运行环境

Windows 10 / 11 六十四位。安卓端需要 Android 8.0 以上。

---

## Français

Tessera est un coffre-fort chiffré pour Windows. Fichiers, mots de passe, notes, historique
du presse-papiers et un gestionnaire de fichiers partagent un seul déverrouillage, et rien
ne quitte votre machine.

### Téléchargement

| Fichier | Pour |
|---|---|
| `Tessera.Setup.exe` | L'installateur classique. Choisissez l'emplacement, raccourci dans le menu Démarrer, désinstallation depuis Applications et fonctionnalités. **Désinstaller ne supprime pas votre coffre.** |
| `Tessera.exe` | Portable. Téléchargez et lancez — aucune écriture dans le registre, utilisable depuis une clé USB. |
| `Tessera-CrossDevice-0.1.0.apk` | L'application Android compagnon, pour appairer un téléphone ou une tablette. À installer manuellement ; elle n'est pas sur Google Play. |

Les deux versions Windows recherchent leurs propres mises à jour et conservent leur format.

### Ce que vous obtenez

- **Cinq façons de déverrouiller, une seule suffit** — mot de passe, code par e-mail,
  application d'authentification, Windows Hello, clé de récupération. La biométrie démarre
  d'elle-même partout où un mot de passe serait demandé, en choisissant visage, empreinte ou
  iris selon ce que votre machine possède.
- **Un coffre qui contient plus que des fichiers** — gestionnaire de mots de passe avec
  authentificateur intégré, historique du presse-papiers qui préserve la mise en forme, notes
  qui s'ouvrent instantanément à plusieurs centaines de mégaoctets, et un gestionnaire de
  fichiers dont le copier-coller dépasse celui de l'Explorateur.
- **Synchronisation multi-appareils sur votre propre réseau** — copiez texte, texte enrichi ou
  images sur le téléphone et collez sur le PC ; envoyez fichiers, dossiers et paquets d'application
  vers un ou plusieurs appareils choisis. Quatre façons d'appairer, commandes pause/reprise/annulation,
  chiffrement de bout en bout et aucun serveur au milieu. Android ne lit le presse-papiers que lorsque
  Tessera est au premier plan, comme l'impose Android 10 et suivants.
- **Six langues** — English, 简体中文, Français, Español, Русский, العربية — changeables
  partout, y compris depuis l'écran de connexion.

### Premier lancement

Windows affichera « Windows a protégé votre ordinateur » la première fois. C'est SmartScreen
qui réagit à un certificat auto-signé, pas un avertissement antivirus : choisissez
**Informations complémentaires → Exécuter quand même**. Cela n'arrive qu'une fois.

L'assistant vous guide ensuite pour définir un mot de passe, une clé de récupération et les
autres méthodes de déverrouillage souhaitées. **Notez la clé de récupération** : elle
n'apparaît qu'une seule fois et c'est le seul retour possible si vous perdez tout le reste.

Guide complet : [guide bureau](../docs/电脑端操作指南.md) ·
[guide Android](../docs/安卓端操作指南.md)

### Configuration requise

Windows 10 ou 11, 64 bits. Android 8.0 ou plus récent pour l'application compagnon.

---

## Español

Tessera es una caja fuerte cifrada para Windows. Archivos, contraseñas, notas, historial del
portapapeles y un gestor de archivos comparten un único desbloqueo, y nada sale de tu equipo.

### Descarga

| Archivo | Para |
|---|---|
| `Tessera.Setup.exe` | El instalador normal. Eliges dónde va, acceso directo en el menú Inicio, desinstalación desde Aplicaciones y características. **Desinstalar no borra tu caja fuerte.** |
| `Tessera.exe` | Portátil. Descarga y ejecuta — sin escrituras en el registro, va bien en un USB. |
| `Tessera-CrossDevice-0.1.0.apk` | La aplicación Android complementaria, para vincular un móvil o una tableta. Se instala a mano; no está en Google Play. |

Ambas versiones de Windows buscan sus propias actualizaciones y mantienen su formato.

### Qué incluye

- **Cinco formas de desbloquear, basta con una** — contraseña, código por correo, aplicación
  de autenticación, Windows Hello, clave de recuperación. La biometría se inicia sola en
  todos los sitios donde se pediría contraseña, eligiendo rostro, huella o iris según lo que
  tenga tu equipo.
- **Una caja fuerte que guarda más que archivos** — gestor de contraseñas con autenticador
  incorporado, historial del portapapeles que conserva el formato, notas que se abren al
  instante con cientos de megabytes, y un gestor de archivos cuyo copiar y pegar supera al
  del Explorador.
- **Sincronización entre dispositivos por tu propia red** — copia texto, texto enriquecido o
  imágenes en el móvil y pégalo en el PC; envía archivos, carpetas y paquetes de aplicación a uno
  o varios dispositivos elegidos. Cuatro formas de vincular, controles de pausa/reanudación/cancelación,
  cifrado de extremo a extremo y ningún servidor de por medio. Android solo deja leer el portapapeles
  cuando Tessera está en primer plano, como exige Android 10 o posterior.
- **Seis idiomas** — English, 简体中文, Français, Español, Русский, العربية — cambiables en
  cualquier pantalla, incluida la de inicio de sesión.

### Primer arranque

Windows mostrará «Windows protegió su PC» la primera vez. Es SmartScreen reaccionando a un
certificado autofirmado, no un aviso de virus: elige **Más información → Ejecutar de todas
formas**. Solo ocurre una vez.

Después el asistente te guía para poner una contraseña, una clave de recuperación y los demás
métodos de desbloqueo que quieras. **Apunta la clave de recuperación**: se muestra una sola
vez y es la única forma de volver a entrar si pierdes todo lo demás.

Guía completa: [guía de escritorio](../docs/电脑端操作指南.md) ·
[guía de Android](../docs/安卓端操作指南.md)

### Requisitos

Windows 10 u 11 de 64 bits. Android 8.0 o posterior para la aplicación complementaria.

---

## Русский

Tessera — зашифрованное хранилище для Windows. Файлы, пароли, заметки, история буфера обмена
и файловый менеджер открываются одной разблокировкой, и ничего не покидает вашу машину.

### Что скачать

| Файл | Для чего |
|---|---|
| `Tessera.Setup.exe` | Обычный установщик. Выбор места установки, ярлык в меню «Пуск», удаление через «Приложения и возможности». **Удаление не стирает ваше хранилище.** |
| `Tessera.exe` | Портативная версия. Скачал и запустил — без записей в реестр, годится для флешки. |
| `Tessera-CrossDevice-0.1.0.apk` | Приложение-компаньон для Android, чтобы связать телефон или планшет. Устанавливается вручную; в Google Play его нет. |

Обе сборки для Windows проверяют обновления сами и остаются в своём формате.

### Что внутри

- **Пять способов разблокировки, достаточно любого** — пароль, код по почте, приложение-
  аутентификатор, Windows Hello, ключ восстановления. Биометрия запускается сама везде, где
  спрашивают пароль, и выбирает лицо, отпечаток или радужку по тому, что есть на машине.
- **Хранилище не только для файлов** — менеджер паролей со встроенным аутентификатором,
  история буфера обмена с сохранением форматирования, заметки, которые открываются мгновенно
  и на сотнях мегабайт, и файловый менеджер, копирующий быстрее Проводника.
- **Синхронизация между устройствами по вашей же сети** — копируйте обычный или форматированный
  текст либо изображения на телефоне и вставляйте на ПК; отправляйте файлы, папки и пакеты приложений
  одному или нескольким выбранным устройствам. Четыре способа сопряжения, пауза/продолжение/отмена,
  сквозное шифрование и никакого сервера посередине. Android разрешает читать буфер лишь когда
  Tessera на переднем плане, как требует Android 10 и новее.
- **Шесть языков** — English, 简体中文, Français, Español, Русский, العربية — переключаются
  где угодно, включая экран входа.

### Первый запуск

В первый раз Windows покажет «Система Windows защитила ваш компьютер». Это SmartScreen
реагирует на самоподписанный сертификат, а не предупреждение об угрозе: выберите
**Подробнее → Выполнить в любом случае**. Так будет только один раз.

Дальше мастер проведёт вас через пароль, ключ восстановления и остальные способы
разблокировки на ваш выбор. **Ключ восстановления запишите** — он показывается ровно один
раз и остаётся единственным способом войти, если потеряется всё остальное.

Подробно: [руководство для ПК](../docs/电脑端操作指南.md) ·
[руководство для Android](../docs/安卓端操作指南.md)

### Требования

Windows 10 или 11, 64-бит. Android 8.0 или новее для приложения-компаньона.

---

## العربية

‏Tessera خزنة مشفّرة لنظام Windows. الملفات وكلمات المرور والملاحظات وسجل الحافظة ومدير
الملفات كلها خلف عملية فتح قفل واحدة، ولا يغادر أي شيء جهازك.

### ماذا تنزّل

| الملف | لمن |
|---|---|
| `Tessera.Setup.exe` | المثبِّت المعتاد. تختار مكان التثبيت، ويضيف اختصارا في قائمة ابدأ، ويمكن إلغاء تثبيته من «التطبيقات والميزات». **إلغاء التثبيت لا يحذف خزنتك.** |
| `Tessera.exe` | نسخة محمولة. نزّلها وشغّلها — بلا كتابة في السجل، وتصلح للعمل من ذاكرة USB. |
| `Tessera-CrossDevice-0.1.0.apk` | تطبيق Android المرافق، لإقران هاتف أو لوح. يُثبَّت يدويا؛ وهو غير متوفر على Google Play. |

كلتا نسختي Windows تتحققان من تحديثاتهما وتبقى كل واحدة على صيغتها.

### ما الذي تحصل عليه

- **خمس طرق لفتح القفل، وتكفي أي واحدة منها** — كلمة مرور، أو رمز بريد إلكتروني، أو تطبيق
  مصادقة، أو Windows Hello، أو مفتاح استرداد. وتبدأ السمات الحيوية من تلقاء نفسها في كل موضع
  تُطلب فيه كلمة المرور، فتختار الوجه أو بصمة الإصبع أو قزحية العين بحسب ما يملكه جهازك.
- **خزنة تحفظ أكثر من الملفات** — مدير كلمات مرور بمصادقة مدمجة، وسجل حافظة يحافظ على
  التنسيق، وملاحظات تُفتح فورا حتى بحجم مئات الميغابايت، ومدير ملفات نسخُه ولصقه أسرع من
  مستكشف الملفات.
- **مزامنة بين الأجهزة عبر شبكتك أنت** — انسخ النص العادي أو المنسق أو الصور على الهاتف والصقه
  على الحاسوب؛ وأرسل الملفات والمجلدات وحزم التطبيقات إلى جهاز واحد أو عدة أجهزة تختارها. أربع طرق
  للاقتران، وتحكم بالإيقاف المؤقت والاستئناف والإلغاء، وتشفير من طرف إلى طرف، وبلا أي خادم في
  المنتصف. لا يسمح Android بقراءة الحافظة إلا حين يكون Tessera في المقدمة، كما يقتضي Android 10
  وما بعده.
- **ست لغات** — English و简体中文 وFrançais وEspañol وРусский والعربية — قابلة للتبديل من أي
  مكان، بما في ذلك شاشة تسجيل الدخول.

### أول تشغيل

سيعرض Windows في المرة الأولى «حمى Windows جهازك». هذا رد فعل SmartScreen على شهادة موقّعة
ذاتيا، وليس تحذيرا من فيروس: اختر **مزيد من المعلومات ← التشغيل على أي حال**. ويحدث مرة واحدة
فقط.

بعدها يرشدك المعالج إلى تعيين كلمة مرور ومفتاح استرداد وأي طرق فتح أخرى تريدها. **دوّن مفتاح
الاسترداد** — فهو يُعرض مرة واحدة فقط، وهو السبيل الوحيد للدخول إن فقدت كل ما عداه.

الدليل الكامل: [دليل الحاسوب](../docs/电脑端操作指南.md) ·
[دليل Android](../docs/安卓端操作指南.md)

### المتطلبات

‏Windows 10 أو 11 بنواة 64 بت. وAndroid 8.0 أو أحدث للتطبيق المرافق.
