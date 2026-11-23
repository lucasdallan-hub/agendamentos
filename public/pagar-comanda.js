(() => {
  const $ = id => document.getElementById(id);
  const tokenPattern = /^[a-f0-9]{64}$/;
  const pollInterval = 5_000;
  const providerInterval = 20_000;
  const pollingStates = new Set(['creating', 'pending', 'unknown']);
  const messages = {
    ready: 'Informe o CPF do pagador para gerar o Pix do consumo.',
    creating: 'Estamos preparando sua cobrança Pix.',
    pending: 'Aguardando o Pix. Escaneie o QR Code ou cole o código no aplicativo do seu banco.',
    unknown: 'Estamos consultando a cobrança. Se você já pagou, aguarde a confirmação.',
    approved: 'Pagamento confirmado.',
    cancelled: 'Esta cobrança foi cancelada. Fale com a arena para receber um novo link.',
    refunded: 'Este pagamento foi devolvido. Consulte o seu banco para acompanhar o crédito.',
    review: 'Este pagamento está em conferência. Fale com a arena para acompanhar.'
  };
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const dateTime = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo'
  });
  const form = $('pdv-payment-form');
  const cpf = $('pdv-payment-cpf');
  const statusText = $('pdv-payment-status');
  const errorText = $('pdv-payment-error');
  const checkButton = $('pdv-payment-check');
  const retryButton = $('pdv-payment-retry');
  const qr = $('pdv-payment-qr');
  const copyCode = $('pdv-payment-code');
  const copyFeedback = $('pdv-payment-copy-feedback');
  let token, payment, active, timer, nextProviderCheck, checkCooldown;

  const money = cents => Number.isSafeInteger(cents) ? brl.format(cents / 100) : '—';
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function pixImage(value) {
    if (typeof value !== 'string' || value.length > 200_000) return '';
    const src = value.startsWith('iVBOR') ? 'data:image/png;base64,' + value : value;
    return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(src) ? src : '';
  }

  function renderReceipt(receipt) {
    $('pdv-payment-receipt').hidden = !receipt;
    const date = receipt?.paid_at ? new Date(receipt.paid_at) : null;
    $('pdv-receipt-amount').textContent = money(receipt?.amount_cents);
    $('pdv-receipt-date').textContent = date && Number.isFinite(+date) ? dateTime.format(date) : '—';
    $('pdv-receipt-payer-row').hidden = !receipt?.payer_name;
    $('pdv-receipt-payer').textContent = receipt?.payer_name ?? '';
    $('pdv-receipt-booking').textContent = receipt?.booking_id != null ? `#${receipt.booking_id}` : '—';
    $('pdv-receipt-reference').textContent = receipt?.reference ?? '—';
  }

  function render() {
    const status = payment?.status;
    const pending = status === 'pending';
    const image = pending ? pixImage(payment.qr_code) : '';
    const code = pending && typeof payment.copy_paste === 'string' && payment.copy_paste.length <= 4096
      ? payment.copy_paste : '';
    $('pdv-payment-total').hidden = !payment;
    $('pdv-payment-amount').textContent = money(payment?.amount_cents);
    form.hidden = status !== 'ready';
    checkButton.hidden = !pollingStates.has(status) && status !== 'review';
    $('pdv-payment-pix').hidden = !image && !code;
    if (image && qr.getAttribute('src') !== image) {
      qr.hidden = false;
      qr.src = image;
    } else if (!image) {
      qr.hidden = true;
      qr.removeAttribute('src');
    }
    if (copyCode.value !== code) {
      copyCode.value = code;
      copyFeedback.textContent = '';
    }
    $('pdv-payment-copy').hidden = !code;
    setText(statusText, pending && !image && !code
      ? 'Aguardando os dados da cobrança Pix.'
      : messages[status] ?? 'Carregando cobrança…');
    renderReceipt(status === 'approved' ? payment.receipt : null);
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (active || document.hidden || !pollingStates.has(payment?.status)) return;
    timer = setTimeout(() => {
      const now = Date.now();
      const verify = now >= nextProviderCheck && now >= checkCooldown;
      void update(verify ? 'check' : 'load', { quiet: true });
    }, pollInterval);
  }

  async function request(operation, payerCpf, signal) {
    const endpoint = `/api/public/pdv/payments/${token}`;
    const url = operation === 'check' ? `${endpoint}/check` : endpoint;
    const options = { cache: 'no-store', credentials: 'omit', signal };
    if (operation !== 'load') {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(operation === 'create' ? { cpf: payerCpf } : {});
    }
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error : 'Não foi possível concluir. Tente novamente.');
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('Retry-After'));
      throw error;
    }
    if (!Object.hasOwn(messages, data?.status) || !Number.isSafeInteger(data.amount_cents)) {
      throw new Error('A arena retornou dados incompletos. Tente novamente.');
    }
    return data;
  }

  function showUnavailable() {
    payment = null;
    cpf.value = '';
    render();
    retryButton.hidden = true;
    errorText.textContent = '';
    setText(statusText, 'Este link é inválido ou não está mais disponível. Peça um novo link à arena.');
  }

  async function update(operation, { quiet = false, payerCpf } = {}) {
    if (active || !tokenPattern.test(token)) return;
    clearTimeout(timer);
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const submit = form.querySelector('button');
    submit.disabled = checkButton.disabled = retryButton.disabled = cpf.disabled = true;
    if (!quiet) errorText.textContent = '';
    if (operation === 'check') {
      checkCooldown = Date.now() + pollInterval;
      nextProviderCheck = Date.now() + providerInterval;
    }
    if (operation === 'create') setText(statusText, 'Gerando seu Pix…');

    try {
      const result = await request(operation, payerCpf, controller.signal);
      if (active !== controller) return;
      if (!pollingStates.has(payment?.status) && pollingStates.has(result.status)) {
        nextProviderCheck = Date.now() + providerInterval;
      }
      payment = result;
      if (payment.status !== 'ready') cpf.value = '';
      retryButton.hidden = true;
      errorText.textContent = '';
      render();
    } catch (error) {
      if (active !== controller) return;
      if ([404, 410].includes(error.status)) {
        showUnavailable();
      } else {
        if (error.status === 429) checkCooldown = Date.now() + (error.retryAfter > 0 ? error.retryAfter * 1000 : providerInterval);
        if (!payment) {
          setText(statusText, 'Não foi possível abrir a cobrança.');
          retryButton.hidden = false;
        }
        if (operation === 'create') render();
        if (!quiet) errorText.textContent = error.status || error.name === 'Error'
          ? error.message : 'Não foi possível falar com a arena. Tente novamente.';
      }
    } finally {
      clearTimeout(timeout);
      if (active === controller) {
        active = null;
        submit.disabled = checkButton.disabled = retryButton.disabled = cpf.disabled = false;
        schedulePoll();
      }
    }
  }

  function openLink() {
    clearTimeout(timer);
    active?.abort();
    active = payment = null;
    checkCooldown = nextProviderCheck = 0;
    token = location.hash.slice(1).toLowerCase();
    cpf.value = '';
    retryButton.hidden = true;
    errorText.textContent = '';
    render();
    if (tokenPattern.test(token)) void update('load');
    else showUnavailable();
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (payment?.status !== 'ready' || active) return;
    const value = cpf.value.trim();
    if (!/^[\d.\- ]{11,14}$/.test(value) || value.replace(/\D/g, '').length !== 11) {
      errorText.textContent = 'Informe um CPF com 11 dígitos.';
      cpf.focus();
      return;
    }
    void update('create', { payerCpf: value.replace(/\D/g, '') });
  });
  retryButton.addEventListener('click', () => { void update('load'); });
  checkButton.addEventListener('click', () => { void update(Date.now() < checkCooldown ? 'load' : 'check'); });
  $('pdv-payment-copy-button').addEventListener('click', async () => {
    const code = copyCode.value;
    if (payment?.status !== 'pending' || !code) return;
    try {
      await navigator.clipboard.writeText(code);
      if (copyCode.value === code) copyFeedback.textContent = 'Código Pix copiado.';
    } catch {
      if (copyCode.value !== code) return;
      copyCode.focus();
      copyCode.select();
      copyFeedback.textContent = 'Selecione e copie o código Pix para usar no aplicativo do seu banco.';
    }
  });
  qr.addEventListener('error', () => { qr.hidden = true; });
  $('pdv-receipt-print').addEventListener('click', () => {
    if (payment?.status !== 'approved' || !payment.receipt) return;
    const address = location.href;
    const historyState = history.state;
    history.replaceState(historyState, '', location.pathname + location.search);
    try { window.print(); }
    finally { history.replaceState(historyState, '', address); }
  });
  window.addEventListener('hashchange', openLink);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if (pollingStates.has(payment?.status)) void update('load', { quiet: true });
  });
  openLink();
})();
