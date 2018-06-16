/* © 2016-2018 FlowCrypt Limited. Limitations apply. Contact human@flowcrypt.com */

'use strict';

tool.catch.try( async () => {

  let url_params = tool.env.url_params(['account_email', 'embedded', 'parent_tab_id']);

  tool.ui.passphrase_toggle(['passphrase_entry']);

  let [primary_ki] = await Store.keys_get(url_params.account_email as string, ['primary']);
  abort_and_render_error_if_keyinfo_empty(primary_ki);

  if(url_params.embedded) {
    $('.change_passhrase_container, .title_container').css('display', 'none');
    $('.line').css('padding', '7px 0');
  }

  async function on_default_expire_user_change() {
    $('.select_loader_container').html(tool.ui.spinner('green'));
    $('.default_message_expire').css('display', 'none');
    await tool.api.cryptup.account_update({default_message_expire: Number($('.default_message_expire').val())});
    window.location.reload();
  }

  let stored_passphrase = await Store.passphrase_get(url_params.account_email as string, primary_ki.longid, true);
  if(stored_passphrase === null) {
    $('#passphrase_to_open_email').prop('checked', true);
  }
  $('#passphrase_to_open_email').change(function () {
    $('.passhprase_checkbox_container').css('display', 'none');
    $('.passphrase_entry_container').css('display', 'block');
  });

  $('.action_change_passphrase').click(() => show_settings_page('/chrome/settings/modules/change_passphrase.htm'));

  $('.action_test_passphrase').click(() => show_settings_page('/chrome/settings/modules/test_passphrase.htm'));

  $('.confirm_passphrase_requirement_change').click(async () => {
    if($('#passphrase_to_open_email').is(':checked')) { // todo - forget pass all phrases, not just master
      let stored_passphrase = await Store.passphrase_get(url_params.account_email as string, primary_ki.longid);
      if($('input#passphrase_entry').val() === stored_passphrase) {
        await Store.passphrase_save('local', url_params.account_email as string, primary_ki.longid, undefined);
        await Store.passphrase_save('session', url_params.account_email as string, primary_ki.longid, undefined);
        window.location.reload();
      } else {
        alert('Pass phrase did not match, please try again.');
        $('input#passphrase_entry').val('').focus();
      }
    } else { // save pass phrase
      var key = openpgp.key.readArmored(primary_ki.private).keys[0];
      if(tool.crypto.key.decrypt(key, $('input#passphrase_entry').val() as string).success) { // text input
        await Store.passphrase_save('local', url_params.account_email as string, primary_ki.longid, $('input#passphrase_entry').val() as string);
        window.location.reload();
      } else {
        alert('Pass phrase did not match, please try again.');
        $('input#passphrase_entry').val('').focus();
      }
    }
  });

  $('.cancel_passphrase_requirement_change').click(() =>  window.location.reload());

  let storage = await Store.get_account(url_params.account_email as string, ['hide_message_password']);
  $('#hide_message_password').prop('checked', storage.hide_message_password === true);
  $('#hide_message_password').change(async function () {
    await Store.set(url_params.account_email as string, {hide_message_password: $(this).is(':checked')});
    window.location.reload();
  });

  let subscription = await Store.subscription();
  if(subscription.active) {
    $('.select_loader_container').html(tool.ui.spinner('green'));
    try {
      let response = await tool.api.cryptup.account_update();
      $('.select_loader_container').html('');
      $('.default_message_expire').val(Number(response.result.default_message_expire).toString()).prop('disabled', false).css('display', 'inline-block');
      $('.default_message_expire').change(on_default_expire_user_change);
    } catch(e) {
      if(e.internal === 'auth' && !url_params.embedded) {
        alert('Your account information is outdated. Please add this device to your account.');
        show_settings_page('/chrome/elements/subscribe.htm', '&source=auth_error');
      } else {
        $('.select_loader_container').html('');
        $('.default_message_expire').replaceWith('(unknown)');
      }
    }
  } else {
    $('.default_message_expire').val('3').css('display', 'inline-block');
    $('.default_message_expire').parent().append('<a href="#">upgrade</a>').find('a').click(function() {
      show_settings_page('/chrome/elements/subscribe.htm');
    });
  }


})();