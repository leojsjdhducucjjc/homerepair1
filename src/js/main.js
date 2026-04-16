const yearEl = document.getElementById("year");
if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

const navShell = document.querySelector(".sticky-nav-shell");
if (navShell) {
  const root = document.documentElement;
  let lastScrollY = window.scrollY;
  let ticking = false;

  const updateNavHeight = () => {
    root.style.setProperty("--nav-shell-height", `${navShell.offsetHeight}px`);
  };

  updateNavHeight();
  window.addEventListener("resize", updateNavHeight);

  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;

      ticking = true;
      window.requestAnimationFrame(() => {
        const currentY = window.scrollY;

        if (currentY <= 20) {
          document.body.classList.remove("nav-hidden");
        } else if (currentY > lastScrollY + 8) {
          document.body.classList.add("nav-hidden");
        } else if (currentY < lastScrollY - 8) {
          document.body.classList.remove("nav-hidden");
        }

        lastScrollY = currentY;
        ticking = false;
      });
    },
    { passive: true }
  );
}
