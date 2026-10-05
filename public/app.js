"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { invoice: null, checking: false, monitoringPaymentId: null };
  const money = (amount) => `KES ${new Intl.NumberFormat("en-KE").format(amount)}`;

  async function api(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new Error("Could not reach the checkout server. Check your connection and try again.");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("The checkout server returned an invalid response.");
    }
    if (!response.ok) throw new Error(body.error || "The request could not be completed.");
    return body;
  }

  function renderInvoice(invoice) {
    state.invoice = invoice;
    const container = $("invoice");
    container.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "line";
    const number = document.createElement("strong");
    number.textContent = invoice.invoiceNumber;
    const badge = document.createElement("span");
    badge.className = `badge${invoice.status === "paid" ? " paid" : ""}`;
    badge.textContent = invoice.status === "paid"
      ? "Paid"
      : invoice.status === "pending" ? "Payment pending" : `Due ${invoice.due}`;
    heading.append(number, badge);
    container.append(heading);

    const details = document.createElement("dl");
    details.style.marginTop = "8px";
    const addLine = (label, value) => {
      const row = document.createElement("div");
      row.className = "line";
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      row.append(term, description);
      details.append(row);
    };
    addLine("Billed to", invoice.customer);
    addLine("Issued", invoice.issued);
    for (const item of invoice.items) addLine(item.description, money(item.amount));
    container.append(details);

    const total = document.createElement("div");
    total.className = "total";
    const label = document.createElement("span");
    const amount = document.createElement("strong");
    label.textContent = "Amount due";
    amount.textContent = money(invoice.status === "paid" ? 0 : invoice.total);
    total.append(label, amount);
    container.append(total);
    updateButton();
  }

  function updateButton() {
    if (!state.invoice) return;
    const button = $("payBtn");
    button.disabled = state.checking || state.invoice.status !== "due";
    button.textContent = state.invoice.status === "paid"
      ? "Already paid"
      : state.invoice.status === "pending"
        ? "Payment pending"
        : `Send ${money(state.invoice.total)} M-Pesa prompt`;
  }

  async function lookup() {
    const invoiceNumber = $("invNo").value.trim().toUpperCase();
    $("invErr").textContent = "";
    $("paymentStatus").textContent = "";
    state.invoice = null;
    $("payBtn").disabled = true;
    if (!invoiceNumber) {
      $("invErr").textContent = "Enter an invoice number.";
      return;
    }
    try {
      const response = await api(`/api/invoices/${encodeURIComponent(invoiceNumber)}`);
      renderInvoice(response.invoice);
      if (response.invoice.pendingPaymentId) {
        void monitorPayment(response.invoice.pendingPaymentId);
      }
    } catch (error) {
      $("invoice").innerHTML = '<p class="empty">Your invoice details will appear here.</p>';
      $("invErr").textContent = error.message;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForPayment(paymentId) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await delay(3000);
      const response = await api(`/api/payments/${encodeURIComponent(paymentId)}`);
      if (response.status !== "pending") return response;
      $("paymentStatus").textContent = "Waiting for M-Pesa confirmation...";
    }
    return { status: "pending", message: "Still waiting for confirmation. You can safely leave this page; check the invoice again later." };
  }

  async function monitorPayment(paymentId) {
    if (state.monitoringPaymentId === paymentId) return;
    state.monitoringPaymentId = paymentId;
    state.checking = true;
    updateButton();
    try {
      $("paymentStatus").textContent = "Waiting for M-Pesa confirmation...";
      const result = await waitForPayment(paymentId);
      if (result.status === "paid") {
        const message = result.receipt
          ? `Payment confirmed. M-Pesa receipt: ${result.receipt}`
          : "Payment confirmed.";
        state.checking = false;
        state.monitoringPaymentId = null;
        await lookup();
        $("paymentStatus").textContent = message;
      } else if (result.status === "failed") {
        $("paymentStatus").textContent = "";
        $("payErr").textContent = result.message;
        state.checking = false;
        state.monitoringPaymentId = null;
        await lookup();
      } else {
        $("paymentStatus").textContent = result.message;
      }
    } catch (error) {
      $("payErr").textContent = error.message;
    } finally {
      state.checking = false;
      state.monitoringPaymentId = null;
      updateButton();
    }
  }

  $("find").addEventListener("click", lookup);
  $("invNo").addEventListener("keydown", (event) => {
    if (event.key === "Enter") lookup();
  });

  $("payBtn").addEventListener("click", async () => {
    if (!state.invoice || state.checking) return;
    $("payErr").textContent = "";
    $("paymentStatus").textContent = "";
    state.checking = true;
    updateButton();
    $("payBtn").disabled = true;
    $("payBtn").textContent = "Sending prompt...";
    try {
      const started = await api("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceNumber: state.invoice.invoiceNumber, phone: $("phone").value })
      });
      $("paymentStatus").textContent = started.message;
      await lookup();
    } catch (error) {
      $("payErr").textContent = error.message;
      state.checking = false;
      updateButton();
    }
  });
})();
