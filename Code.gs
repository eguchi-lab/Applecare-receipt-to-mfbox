/**
 * メール領収書をPDF化して、Money Forward クラウドBoxへ渡す補助スクリプト。
 *
 * 通常の流れ:
 * - 定義済みルールに合う未処理の領収書メールを探す。
 * - ルールに応じて、メール本文をPDF化するか添付PDFを取り出す。
 * - PDFをGoogle Driveへ保存する。
 * - 設定が有効なら、Money Forward クラウドBoxへPDF添付メールを送る。
 * - 処理済みラベルを付けて二重送信を防ぐ。
 */

const CONFIG = {
  processedLabelName: 'mf-box-sent',
  skippedLabelName: 'mf-box-skip',
  errorLabelName: 'mf-box-error',
  defaultMaxThreads: 20,
  receiptRules: [
    {
      name: 'Apple AppleCare',
      searchQuery:
        'from:no_reply@email.apple.com subject:"Apple からの領収書です" newer_than:7d -label:mf-box-sent -label:mf-box-skip',
      fileNamePrefix: 'Apple_AppleCare',
      amountCurrency: 'yen',
      source: 'bodyPdf',
      matches: function (message, plainBody) {
        const from = message.getFrom();
        const subject = message.getSubject();
        const hasAppleCare = ['AppleCare', 'AppleCare+'].some((keyword) => plainBody.indexOf(keyword) !== -1);
        return /no_reply@email\.apple\.com/i.test(from) && subject === 'Apple からの領収書です' && hasAppleCare;
      },
      skipReason: 'AppleCareキーワードが見つかりません',
    },
    {
      name: 'Anthropic receipt',
      searchQuery:
        'from:invoice+statements@mail.anthropic.com subject:"Your receipt from Anthropic, PBC" newer_than:30d -label:mf-box-sent -label:mf-box-skip',
      fileNamePrefix: 'Anthropic_Receipt',
      amountCurrency: 'usd',
      source: 'pdfAttachment',
      matches: function (message) {
        const from = message.getFrom();
        const subject = message.getSubject();
        return /invoice\+statements@mail\.anthropic\.com/i.test(from) && /^Your receipt from Anthropic, PBC/i.test(subject);
      },
      skipReason: 'Anthropic領収書ではありません',
    },
  ],
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
 * テストモード。対象メールのPDF証憑をDriveへ保存する。
 * Money Forward クラウドBoxへは送らず、処理済みラベルも付けない。
 */
function previewAppleCareReceipts() {
  return processAppleCareReceipts_({ dryRun: true });
}

/**
 * 本番モード。対象メールのPDF証憑をDriveへ保存し、
 * スクリプトプロパティの設定に従って添付メールを送り、処理済みラベルを付ける。
 */
function processAppleCareReceipts() {
  return processAppleCareReceipts_({ dryRun: false });
}

function processAppleCareReceipts_(options) {
  const settings = getSettings_();
  const labels = ensureLabels_();
  const results = [];

  CONFIG.receiptRules.forEach((rule) => {
    const threads = GmailApp.search(rule.searchQuery, 0, settings.maxThreads);
    Logger.log('[%s] 候補スレッド: %s 件。dryRun=%s', rule.name, threads.length, options.dryRun);

    threads.forEach((thread) => {
      const messages = thread.getMessages();
      messages.forEach((message) => {
        const result = processMessage_(message, thread, labels, settings, options, rule);
        if (result) {
          results.push(result);
        }
      });
    });
  });

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

function processMessage_(message, thread, labels, settings, options, rule) {
  const subject = message.getSubject();
  const plainBody = message.getPlainBody();

  if (!rule.matches(message, plainBody)) {
    Logger.log('[%s] 対象外としてスキップ: %s', rule.name, subject);
    if (!options.dryRun) {
      thread.addLabel(labels.skipped);
    }
    return {
      status: 'skipped',
      rule: rule.name,
      subject,
      reason: rule.skipReason,
      messageId: message.getId(),
    };
  }

  try {
    // PDFはDriveに必ず保存し、メール送信は設定で切り替える。
    const pdfs = buildEvidencePdfs_(message, plainBody, rule);
    const saveResults = pdfs.map((pdf) => savePdfToDrive_(pdf, settings.driveFolderId));

    if (!options.dryRun) {
      sendPdfs_(pdfs, message, settings);
      thread.addLabel(labels.processed);
      thread.removeLabel(labels.error);
    }

    const result = {
      status: options.dryRun ? 'preview' : 'processed',
      rule: rule.name,
      fileName: pdfs[0].getName(),
      driveUrl: saveResults[0].file.getUrl(),
      driveFileCreated: saveResults[0].created,
      files: saveResults.map((saveResult, index) => {
        return {
          fileName: pdfs[index].getName(),
          driveUrl: saveResult.file.getUrl(),
          driveFileCreated: saveResult.created,
        };
      }),
      subject,
      messageId: message.getId(),
    };
    Logger.log('%s: %s files=%s', result.status, rule.name, result.files.length);
    return result;
  } catch (error) {
    thread.addLabel(labels.error);
    Logger.log('ERROR: %s\n%s', error.message, error.stack);
    return {
      status: 'error',
      rule: rule.name,
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

function buildEvidencePdfs_(message, plainBody, rule) {
  if (rule.source === 'pdfAttachment') {
    return buildAttachmentPdfs_(message, plainBody, rule);
  }

  const fileName = buildFileName_(message, plainBody, rule);
  return [buildBodyPdf_(message, fileName)];
}

function buildBodyPdf_(message, fileName) {
  const html = buildEvidenceHtml_(message);
  return Utilities.newBlob(html, 'text/html', fileName + '.html')
    .getAs(MimeType.PDF)
    .setName(fileName + '.pdf');
}

function buildAttachmentPdfs_(message, plainBody, rule) {
  const attachments = message.getAttachments({
    includeInlineImages: false,
    includeAttachments: true,
  });
  const pdfAttachments = attachments.filter((attachment) => {
    const contentType = String(attachment.getContentType() || '').toLowerCase();
    const name = String(attachment.getName() || '');
    return contentType.indexOf('pdf') !== -1 || /\.pdf$/i.test(name);
  });

  if (pdfAttachments.length === 0) {
    throw new Error(rule.name + ' のPDF添付が見つかりません。');
  }

  return pdfAttachments.map((attachment, index) => {
    const fileName = buildFileName_(message, plainBody, rule, index);
    return attachment.copyBlob().setName(fileName + '.pdf');
  });
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

function sendPdfs_(pdfs, message, settings) {
  const subject = '[証憑] ' + pdfs.map((pdf) => pdf.getName()).join(', ');
  const body =
    'Gmailから取得したメール領収書PDFです。\n\n' +
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
      attachments: pdfs.map((pdf) => pdf.copyBlob()),
    });
  }

  if (settings.sendToMfBox) {
    MailApp.sendEmail({
      to: settings.mfBoxEmail,
      subject,
      body,
      attachments: pdfs.map((pdf) => pdf.copyBlob()),
    });
  }
}

function buildFileName_(message, plainBody, rule, index) {
  const dateTime = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmmss');
  const amount = extractAmount_(plainBody, rule.amountCurrency);
  const amountPart = amount ? '_' + amount + rule.amountCurrency : '';
  const indexPart = index ? '_' + (index + 1) : '';
  const messageIdPart = '_' + shortMessageId_(message.getId());
  return sanitizeFileName_(dateTime + '_' + rule.fileNamePrefix + amountPart + indexPart + messageIdPart);
}

function shortMessageId_(messageId) {
  return String(messageId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10) || 'noMessageId';
}

function extractAmount_(plainBody, currency) {
  const pattern = currency === 'usd' ? /\$\s?([0-9,]+(?:\.[0-9]{2})?)/g : /[¥￥]\s?([0-9,]+)/g;
  const matches = plainBody.match(pattern);
  if (!matches || matches.length === 0) {
    return '';
  }

  // ファイル名用に、本文内の金額のうち最大値を領収書金額の候補として使う。
  const amounts = matches
    .map((value) => Number(value.replace(/[^\d.]/g, '')))
    .filter((value) => !isNaN(value) && value > 0);

  if (amounts.length === 0) {
    return '';
  }

  const amount = Math.max.apply(null, amounts);
  return currency === 'usd' ? String(amount).replace('.', '-') : String(amount);
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
