(async function () {
  if (!('serviceWorker' in navigator)) return;
  if (!('PushManager' in window)) return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');

    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      console.log('Notifications not granted');
      return;
    }

    const res = await fetch('/push/public-key');
    const data = await res.json();
    if (!data.publicKey || data.publicKey === 'PUT_YOUR_PUBLIC_KEY_HERE') {
      console.warn('VAPID public key not set on server.');
      return;
    }

    const publicKey = data.publicKey;
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    }

    await fetch('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    });
    console.log('Push subscription registered.');
  } catch (err) {
    console.error('Push / SW error', err);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
})();