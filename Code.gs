/**
 * AppleCareのメール領収書をPDF化して、Money Forward クラウドBoxへ渡す補助スクリプト。
 *
 * 通常の流れ:
 * - no_reply@email.apple.com から届いた未処理のApple領収書メールを探す。
 * - 本文に AppleCare / AppleCare+ が含まれるメールだけを対象にする。
 * - メール本文に証憑用メタ情報を付けてPDF化する。
 * - PDFをGoogle Driveへ保存する。
 * - 設定が有効なら、Money Forward クラウドBoxへPDF添付メールを送る。
 * - 処理済みラベルを付けて二重送信を防ぐ。
 */

const CONFIG = {
  searchQuery:
    'from:no_reply@email.apple.com subject:"Apple からの領収書です" newer_than:7d -label:mf-box-sent -label:mf-box-skip',
  processedLabelName: 'mf-box-sent',
  skippedLabelName: 'mf-box-skip',
  errorLabelName: 'mf-box-error',
  defaultMaxThreads: 20,
  appleCareKeywords: ['AppleCare', 'AppleCare+'],
};

const PROPERTY_KEYS = {
  driveFolderId: 'DRIVE_FOLDER_ID',
  mfBoxEmail: 'MF_BOX_EMAIL',
  testEmail: 'TEST_EMAIL',
  sendToMfBox: 'SEND_TO_MF_BOX',
  sendTestCopy: 'SEND_TEST_COPY',
  maxThreads: 'MAX_THREADS',
};

/**
 * 初回セットアップ用。
 * 1. 最初にこの関数を1回だけ実行する。
 * 2. Apps Script の「プロジェクトの設定」>「スクリプト プロパティ」で値を編集する。
 * 3. previewAppleCareReceipts() を実行してPDFの見た目を確認する。
 */
function installDefaultProperties() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperties();
  const defaults = {
    [PROPERTY_KEYS.driveFolderId]: current[PROPERTY_KEYS.driveFolderId] || '',
    [PROPERTY_KEYS.mfBoxEmail]: current[PROPERTY_KEYS.mfBoxEmail] || '',
    [PROPERTY_KEYS.testEmail]: current[PROPERTY_KEYS.testEmail] || Session.getActiveUser().getEmail(),
    [PROPERTY_KEYS.sendToMfBox]: current[PROPERTY_KEYS.sendToMfBox] || 'false',
    [PROPERTY_KEYS.sendTestCopy]: current[PROPERTY_KEYS.sendTestCopy] || 'true',
    [PROPERTY_KEYS.maxThreads]: current[PROPERTY_KEYS.maxThreads] || String(CONFIG.defaultMaxThreads),
  };

  props.setProperties(defaults, true);
  ensureLabels_();
  Logger.log('初期プロパティとGmailラベルを準備しました。');
}

/**
 * テストモード。対象メールをPDF化してDriveへ保存する。
 * Money Forward クラウドBoxへは送らず、処理済みラベルも付けない。
 */
function previewAppleCareReceipts() {
  return processAppleCareReceipts_({ dryRun: true });
}

/**
 * 本番モード。対象メールをPDF化してDriveへ保存し、
 * スクリプトプロパティの設定に従って添付メールを送り、処理済みラベルを付ける。
 */
function processAppleCareReceipts() {
  return processAppleCareReceipts_({ dryRun: false });
}

function processAppleCareReceipts_(options) {
  const settings = getSettings_();
  const labels = ensureLabels_();
  const threads = GmailApp.search(CONFIG.searchQuery, 0, settings.maxThreads);
  const results = [];

  Logger.log('候補スレッド: %s 件。dryRun=%s', threads.length, options.dryRun);

  threads.forEach((thread) => {
    const messages = thread.getMessages();
    messages.forEach((message) => {
      const result = processMessage_(message, thread, labels, settings, options);
      if (result) {
        results.push(result);
      }
    });
  });

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

function processMessage_(message, thread, labels, settings, options) {
  const subject = message.getSubject();
  const plainBody = message.getPlainBody();

  // Appleの通常領収書には他の商品も混ざるので、AppleCare本文だけに絞る。
  if (!isAppleCareReceipt_(message, plainBody)) {
    Logger.log('AppleCare以外のメールとしてスキップ: %s', subject);
    if (!options.dryRun) {
      thread.addLabel(labels.skipped);
    }
    return {
      status: 'skipped',
      subject,
      reason: 'AppleCareキーワードが見つかりません',
      messageId: message.getId(),
    };
  }

  try {
    // PDFはDriveに必ず保存し、メール送信は設定で切り替える。
    const fileName = buildFileName_(message, plainBody);
    const pdf = buildPdf_(message, fileName);
    const saveResult = savePdfToDrive_(pdf, settings.driveFolderId);

    if (!options.dryRun) {
      sendPdf_(pdf, message, settings);
      thread.addLabel(labels.processed);
      thread.removeLabel(labels.error);
    }

    const result = {
      status: options.dryRun ? 'preview' : 'processed',
      fileName: pdf.getName(),
      driveUrl: saveResult.file.getUrl(),
      driveFileCreated: saveResult.created,
      subject,
      messageId: message.getId(),
    };
    Logger.log('%s: %s created=%s', result.status, result.fileName, result.driveFileCreated);
    return result;
  } catch (error) {
    thread.addLabel(labels.error);
    Logger.log('ERROR: %s\n%s', error.message, error.stack);
    return {
      status: 'error',
      subject,
      messageId: message.getId(),
      error: error.message,
    };
  }
}

function getSettings_() {
  const props = PropertiesService.getScriptProperties();
  const driveFolderId = props.getProperty(PROPERTY_KEYS.driveFolderId);
  const mfBoxEmail = props.getProperty(PROPERTY_KEYS.mfBoxEmail);
  const testEmail = props.getProperty(PROPERTY_KEYS.testEmail);
  const sendToMfBox = props.getProperty(PROPERTY_KEYS.sendToMfBox) === 'true';
  const sendTestCopy = props.getProperty(PROPERTY_KEYS.sendTestCopy) !== 'false';
  const maxThreads = Number(props.getProperty(PROPERTY_KEYS.maxThreads)) || CONFIG.defaultMaxThreads;

  if (!driveFolderId) {
    throw new Error('スクリプトプロパティ DRIVE_FOLDER_ID が必要です。');
  }
  if (sendToMfBox && !mfBoxEmail) {
    throw new Error('SEND_TO_MF_BOX=true の場合、スクリプトプロパティ MF_BOX_EMAIL が必要です。');
  }
  if (sendTestCopy && !testEmail) {
    throw new Error('SEND_TEST_COPY=true の場合、スクリプトプロパティ TEST_EMAIL が必要です。');
  }

  return {
    driveFolderId,
    mfBoxEmail,
    testEmail,
    sendToMfBox,
    sendTestCopy,
    maxThreads,
  };
}

function ensureLabels_() {
  return {
    processed: getOrCreateLabel_(CONFIG.processedLabelName),
    skipped: getOrCreateLabel_(CONFIG.skippedLabelName),
    error: getOrCreateLabel_(CONFIG.errorLabelName),
  };
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function isAppleCareReceipt_(message, plainBody) {
  const from = message.getFrom();
  const subject = message.getSubject();
  const isAppleSender = /no_reply@email\.apple\.com/i.test(from);
  const isReceiptSubject = subject === 'Apple からの領収書です';
  const hasAppleCare = CONFIG.appleCareKeywords.some((keyword) => plainBody.indexOf(keyword) !== -1);
  return isAppleSender && isReceiptSubject && hasAppleCare;
}

function buildPdf_(message, fileName) {
  const html = buildEvidenceHtml_(message);
  return Utilities.newBlob(html, 'text/html', fileName + '.html')
    .getAs(MimeType.PDF)
    .setName(fileName + '.pdf');
}

function buildEvidenceHtml_(message) {
  // PDF先頭にメールのメタ情報を残して、後から原本メールを追跡できるようにする。
  const metadata = [
    ['From', message.getFrom()],
    ['To', message.getTo()],
    ['Date', Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss Z')],
    ['Subject', message.getSubject()],
    ['Gmail Message ID', message.getId()],
  ];

  const metadataRows = metadata
    .map(([key, value]) => {
      return '<tr><th>' + escapeHtml_(key) + '</th><td>' + escapeHtml_(value || '') + '</td></tr>';
    })
    .join('');

  return (
    '<!doctype html><html><head><meta charset="UTF-8">' +
    '<style>' +
    'body{font-family:Arial,"Hiragino Sans","Noto Sans JP",sans-serif;font-size:12px;color:#111;}' +
    '.metadata{border:1px solid #ccc;margin-bottom:16px;padding:12px;}' +
    '.metadata h1{font-size:16px;margin:0 0 8px;}' +
    '.metadata table{border-collapse:collapse;width:100%;}' +
    '.metadata th{width:140px;text-align:left;vertical-align:top;color:#555;padding:3px 8px 3px 0;}' +
    '.metadata td{padding:3px 0;word-break:break-word;}' +
    '.receipt{border-top:1px solid #ddd;padding-top:16px;}' +
    '</style></head><body>' +
    '<div class="metadata"><h1>メール領収書 証憑メタ情報</h1><table>' +
    metadataRows +
    '</table></div><div class="receipt">' +
    message.getBody() +
    '</div></body></html>'
  );
}

function savePdfToDrive_(pdf, driveFolderId) {
  const folder = DriveApp.getFolderById(driveFolderId);
  const existingFiles = folder.getFilesByName(pdf.getName());

  // 同じメールから作るPDFは同じファイル名になる。既にあれば増やさず、そのファイルを再利用する。
  if (existingFiles.hasNext()) {
    return {
      file: existingFiles.next(),
      created: false,
    };
  }

  return {
    file: folder.createFile(pdf.copyBlob()),
    created: true,
  };
}

function sendPdf_(pdf, message, settings) {
  const subject = '[証憑] ' + pdf.getName();
  const body =
    'Gmailから生成したAppleCare領収書PDFです。\n\n' +
    '元メール件名: ' + message.getSubject() + '\n' +
    '元メール日時: ' +
    Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss Z') +
    '\n' +
    'GmailメッセージID: ' + message.getId() + '\n';

  if (settings.sendTestCopy) {
    MailApp.sendEmail({
      to: settings.testEmail,
      subject: '[TEST] ' + subject,
      body,
      attachments: [pdf.copyBlob()],
    });
  }

  if (settings.sendToMfBox) {
    MailApp.sendEmail({
      to: settings.mfBoxEmail,
      subject,
      body,
      attachments: [pdf.copyBlob()],
    });
  }
}

function buildFileName_(message, plainBody) {
  const dateTime = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmmss');
  const amount = extractAmount_(plainBody);
  const amountPart = amount ? '_' + amount + 'yen' : '';
  const messageIdPart = '_' + shortMessageId_(message.getId());
  return sanitizeFileName_(dateTime + '_Apple_AppleCare' + amountPart + messageIdPart);
}

function shortMessageId_(messageId) {
  return String(messageId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10) || 'noMessageId';
}

function extractAmount_(plainBody) {
  const matches = plainBody.match(/[¥￥]\s?([0-9,]+)/g);
  if (!matches || matches.length === 0) {
    return '';
  }

  // ファイル名用に、本文内の円金額のうち最大値を領収書金額の候補として使う。
  const amounts = matches
    .map((value) => Number(value.replace(/[^\d]/g, '')))
    .filter((value) => !isNaN(value) && value > 0);

  if (amounts.length === 0) {
    return '';
  }

  return String(Math.max.apply(null, amounts));
}

function sanitizeFileName_(value) {
  return value.replace(/[\\/:*?"<>|#%{}~&]/g, '-').replace(/\s+/g, '_').slice(0, 120);
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
