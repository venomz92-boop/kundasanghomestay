function handlePaymentReturn() {
  var params = new URLSearchParams(window.location.search);
  var bookingId = params.get('booking');
  var paymentReturn = params.get('payment_return');
  if (bookingId && paymentReturn === '1') {
    fetch('/api/verify-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ bookingId: bookingId })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showThankYouModal(bookingId, data.booking);
      } else {
        // Payment is still processing – show a friendly message
        showAlert(
          'Payment Confirmed',
          'Your payment has been received. We are confirming it with the host. You will see the status update in My Bookings shortly.'
        ).then(() => {
          window.location.href = '/mybookings.html';
        });
      }
    })
    .catch(() => {
      showAlert('Error', 'Something went wrong. Please check your bookings later.');
      window.location.href = '/mybookings.html';
    });

    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
}
