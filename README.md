# Mail Receipt to Money Forward Cloud Box

メール領収書を Gmail から拾い、本文PDFまたは添付PDFを Google Drive に保存します。
設定を有効にすると Money Forward クラウドBoxのメール取込アドレスへ PDF 添付メールを送ります。

## 対象メール

現在の対象ルール:

### AppleCare

```text
from:no_reply@email.apple.com subject:"Apple からの領収書です" newer_than:7d -label:mf-box-sent -label:mf-box-skip
```

さらに本文に `AppleCare` または `AppleCare+` が含まれるメールだけ処理します。
AppleCare はメールにPDF添付がないため、メール本文をPDF化します。
過去分をまとめて処理したい場合だけ、`newer_than:30d` や `newer_than:180d` に一時変更してください。

### Anthropic

```text
from:invoice+statements@mail.anthropic.com subject:"Your receipt from Anthropic, PBC" newer_than:30d -label:mf-box-sent -label:mf-box-skip
```

件名が `Your receipt from Anthropic, PBC` で始まるメールを処理します。
Anthropic はメールに添付されているPDFをそのまま保存・転送します。メール本文のPDF化はしません。

### Google Store Pixel Care+

```text
from:googlestore-noreply@google.com subject:"Pixel Care+" newer_than:7d -label:mf-box-sent -label:mf-box-skip
```

Google Store の Pixel Care+ 定期購入領収書を処理します。
Pixel Care+ はメールにPDF添付がないため、メール本文をPDF化します。

## PDFファイル名

生成されるPDF名は、同じ日付・同じ金額でも区別できるように、メール日時とGmailメッセージIDの末尾を含めます。

例:

```text
2026-09-16_121530_Apple_AppleCare_9800yen_ab12cd34ef.pdf
2026-09-19_175602_Anthropic_Receipt_110usd_ab12cd34ef.pdf
```

Google Drive は同名ファイルを作成しても上書きしませんが、一覧上で区別しやすいように最初から一意に近い名前にしています。

## セットアップ

1. Google Apps Script の新規プロジェクトを作る。
2. `Code.gs` の内容を貼り付ける。
3. Drive に保存先フォルダを作り、フォルダ ID を控える。
4. `installDefaultProperties()` を実行する。
5. Apps Script の「プロジェクトの設定」からスクリプト プロパティを設定する。

必要なスクリプト プロパティ:

```text
DRIVE_FOLDER_ID=<PDF保存先のGoogle DriveフォルダID>
MF_BOX_EMAIL=<Money ForwardクラウドBoxのメール取込アドレス>
TEST_EMAIL=<テストコピーの送信先。通常は自分のメール>
SEND_TO_MF_BOX=false
SEND_TEST_COPY=true
MAX_THREADS=20
```

最初は `SEND_TO_MF_BOX=false` のままテストしてください。

## DRIVE_FOLDER_ID の確認方法

`DRIVE_FOLDER_ID` は、PDFを保存するGoogle DriveフォルダのIDです。

1. Google DriveでPDF保存先フォルダを作る。
2. そのフォルダをブラウザで開く。
3. アドレスバーのURLを確認する。

URLは次のような形になります。

```text
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
```

この場合、`DRIVE_FOLDER_ID` に入れる値は最後のこの部分です。

```text
1AbCdEfGhIjKlMnOpQrStUvWxYz
```

フォルダURLに `?usp=sharing` などが付いている場合も、`/folders/` の後から `?` の手前までがフォルダIDです。

## テスト手順

1. `previewAppleCareReceipts()` を実行する。
2. 実行ログに対象メールと Drive URL が出ることを確認する。
3. Drive に生成された PDF を開き、領収書として読めるか確認する。
4. `processAppleCareReceipts()` を実行する。
5. `TEST_EMAIL` に PDF 添付メールが届くことを確認する。
6. 問題なければ `SEND_TO_MF_BOX=true` に変更する。
7. 再度 `processAppleCareReceipts()` を実行し、クラウドBoxにPDFが入ることを確認する。

`processAppleCareReceipts()` が成功すると Gmail スレッドに `mf-box-sent` ラベルが付き、次回以降は対象外になります。

同じメールを再実行した場合は、同じファイル名のPDFがDrive内に既にあれば新規作成せず、既存ファイルを再利用します。
実行ログの `driveFileCreated` が `false` なら既存ファイルを使っています。

## 定期実行

動作確認後、Apps Script のトリガーで `processAppleCareReceipts()` を時間主導型にします。

おすすめ:

```text
1時間おき
```

トリガーに設定する関数は `previewAppleCareReceipts()` ではなく、`processAppleCareReceipts()` です。
`previewAppleCareReceipts()` は手動確認用で、処理済みラベルを付けません。

カード明細の未分類検知と連動させる場合でも、このスクリプト側は「領収書PDFを先にクラウドBoxへ置く」役割にしておくと安全です。

## ラベル

自動作成される Gmail ラベル:

```text
mf-box-sent
mf-box-skip
mf-box-error
```

`mf-box-error` が付いたスレッドは、ログを確認してから手動でラベルを外すと再処理できます。

## 注意

- Money Forward クラウドBoxのメール取込は添付ファイル保存用なので、このスクリプトはPDFを添付して送ります。
- Apple のメールHTMLが変わった場合、本文PDF化の見た目や金額抽出が崩れる可能性があります。
- Anthropic の添付ファイル形式やファイル数が変わった場合、PDF検出の調整が必要になる可能性があります。
- 金額抽出はファイル名用です。仕訳金額の確定には Money Forward 側の明細とPDF本文を確認してください。
