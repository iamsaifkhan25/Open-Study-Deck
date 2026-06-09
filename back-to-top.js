/**
 * Open Study Deck - Back to Top Button Controller
 * Features: Scroll progress circle, smooth navigation, and auto-fade when idle.
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. Create and inject back-to-top button
  const btn = document.createElement('button');
  btn.id = 'back-to-top';
  btn.className = 'back-to-top-btn';
  btn.setAttribute('aria-label', 'Back to top');
  
  // Circumference = 2 * Math.PI * r = 2 * Math.PI * 22 = 138.23
  const circumference = 138.23;
  
  btn.innerHTML = `
    <svg class="progress-circle" viewBox="0 0 48 48">
      <circle class="progress-circle-bg" cx="24" cy="24" r="22" />
      <circle class="progress-circle-bar" cx="24" cy="24" r="22" />
    </svg>
    <span class="arrow-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="18 15 12 9 6 15"></polyline>
      </svg>
    </span>
  `;
  
  document.body.appendChild(btn);
  
  const progressBar = btn.querySelector('.progress-circle-bar');
  let idleTimeout = null;
  let isHovered = false;
  
  // Set initial progress bar offset
  if (progressBar) {
    progressBar.style.strokeDasharray = circumference;
    progressBar.style.strokeDashoffset = circumference;
  }
  
  // Calculate and update scroll percentage
  function updateProgress() {
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    
    // Calculate scroll percentage (0 to 1)
    const scrollPercent = scrollHeight > 0 ? scrollY / scrollHeight : 0;
    
    // Update SVG progress circle
    if (progressBar) {
      const offset = circumference - (scrollPercent * circumference);
      progressBar.style.strokeDashoffset = offset;
    }
    
    return scrollY;
  }
  
  function showButton() {
    btn.classList.add('visible');
  }
  
  function hideButton() {
    if (!isHovered) {
      btn.classList.remove('visible');
    }
  }
  
  // Manage idle visibility state
  function resetIdleTimer() {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    if (scrollY > 150) {
      showButton();
      // Auto-hide only if the user is not currently hovering over the button
      if (!isHovered) {
        idleTimeout = setTimeout(hideButton, 2500); // Fades out after 2.5 seconds of scroll inactivity
      }
    } else {
      hideButton();
    }
  }
  
  // Scroll Listener
  window.addEventListener('scroll', () => {
    updateProgress();
    resetIdleTimer();
  }, { passive: true });
  
  // Hover events to prevent hiding when user wants to click
  btn.addEventListener('mouseenter', () => {
    isHovered = true;
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    if (scrollY > 150) {
      showButton();
    }
  });
  
  btn.addEventListener('mouseleave', () => {
    isHovered = false;
    resetIdleTimer();
  });
  
  // Click event: Smooth scroll to top
  btn.addEventListener('click', () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  });
  
  // Initial run in case the page is loaded scrolled down
  updateProgress();
  const initialScrollY = window.scrollY || document.documentElement.scrollTop;
  if (initialScrollY > 150) {
    resetIdleTimer();
  }
});
