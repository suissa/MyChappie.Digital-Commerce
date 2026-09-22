// Mobile-First GSAP Animation & Runtime Controller for HyperCommerce Splash Screen
(function () {
  const mascotEl = document.getElementById('mascot');
  const textLogoEl = document.getElementById('text-logo');
  const authContainer = document.getElementById('auth-container');

  function decodeImages() {
    const imgs = Array.prototype.slice.call(document.images);
    return Promise.all(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })
    );
  }

  function startAnimation() {
    if (!window.gsap) {
      if (mascotEl) mascotEl.style.opacity = '1';
      if (textLogoEl) textLogoEl.style.opacity = '1';
      return;
    }

    const tl = gsap.timeline();

    tl.fromTo(
      mascotEl,
      { scale: 0.2, opacity: 0, z: -800 },
      {
        scale: 1,
        opacity: 1,
        z: 0,
        duration: 1.2,
        ease: 'power3.out',
      },
      0
    );

    tl.fromTo(
      textLogoEl,
      { scale: 0.7, opacity: 0, y: 30 },
      {
        scale: 1,
        opacity: 1,
        y: 0,
        duration: 0.9,
        ease: 'power2.out',
      },
      0.6
    );

    tl.fromTo(
      authContainer,
      { opacity: 0, y: 25 },
      {
        opacity: 1,
        y: 0,
        duration: 0.7,
        ease: 'power2.out',
      },
      1.0
    );
  }

  window.addEventListener('DOMContentLoaded', () => {
    decodeImages().then(() => {
      startAnimation();
    });
  });
})();
