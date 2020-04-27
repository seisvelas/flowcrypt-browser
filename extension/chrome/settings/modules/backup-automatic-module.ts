/* ©️ 2016 - present FlowCrypt a.s. Limitations apply. Contact human@flowcrypt.com */

'use strict';

import { Lang } from '../../../js/common/lang.js';
import { ViewModule } from '../../../js/common/view-module.js';
import { BackupView } from './backup.js';
import { Settings } from '../../../js/common/settings.js';
import { UnreportableError } from '../../../js/common/platform/catch.js';
import { Ui } from '../../../js/common/browser/ui.js';
import { ApiErr } from '../../../js/common/api/error/api-error.js';
import { PgpKey } from '../../../js/common/core/pgp-key.js';
import { Assert } from '../../../js/common/assert.js';
import { GoogleAuth } from '../../../js/common/api/google-auth.js';
import { KeyStore } from '../../../js/common/platform/store/key-store.js';

export class BackupAutomaticModule extends ViewModule<BackupView> {

  public simpleSetupAutoBackupRetryUntilSuccessful = async () => {
    try {
      await this.setupCreateSimpleAutomaticInboxBackup();
    } catch (e) {
      return await Settings.promptToRetry(e, Lang.setup.failedToBackUpKey, this.setupCreateSimpleAutomaticInboxBackup);
    }
  }

  private setupCreateSimpleAutomaticInboxBackup = async () => {
    const [primaryKi] = await KeyStore.get(this.view.acctEmail, ['primary']);
    if (!(await PgpKey.readAsOpenPGP(primaryKi.private)).isFullyEncrypted()) {
      await Ui.modal.warning('Key not protected with a pass phrase, skipping');
      throw new UnreportableError('Key not protected with a pass phrase, skipping');
    }
    Assert.abortAndRenderErrorIfKeyinfoEmpty(primaryKi);
    try {
      await this.view.manualModule.doBackupOnEmailProvider(primaryKi.private);
      await this.view.renderBackupDone();
    } catch (e) {
      if (ApiErr.isAuthPopupNeeded(e)) {
        await Ui.modal.info("Authorization Error. FlowCrypt needs to reconnect your Gmail account");
        const connectResult = await GoogleAuth.newAuthPopup({ acctEmail: this.view.acctEmail });
        if (!connectResult.error) {
          await this.setupCreateSimpleAutomaticInboxBackup();
        } else {
          throw e;
        }
      }
    }
  }

}
