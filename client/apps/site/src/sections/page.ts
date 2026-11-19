/** Page-wide behaviour: the nav's scroll progress and current section, fade-in on scroll, download links, and the "Demo people" switch. */
import { $, $$ } from "../lib/dom";
import { setDemoPeopleVisible } from "../lib/stage";

const REPO = "KanyeS/inklayer";

export function setUpPage(): void {
  demoPeopleSwitch();
  revealOnScroll();
  navProgress();
  void latestReleaseLinks();
}

/** Hides every pretend teammate, so a visitor using the real extension sees only their own team. Remembered. */
function demoPeopleSwitch(): void {
  const toggle = $<HTMLInputElement>("#people-toggle");
  toggle.checked = localStorage.getItem("inklayer-demo-people") !== "off";
  const apply = () => {
    setDemoPeopleVisible(toggle.checked);
    localStorage.setItem("inklayer-demo-people", toggle.checked ? "on" : "off");
  };
  toggle.addEventListener("change", apply);
  apply();
}

function revealOnScroll(): void {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  for (const el of $$(".reveal")) observer.observe(el);
}

/** The bar under the nav fills as you scroll, and the link for the section you're in is highlighted. */
function navProgress(): void {
  const bar = $("#progress");
  const links = $$<HTMLAnchorElement>(".nav-links a");
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = `${(scrollY / Math.max(1, max)) * 100}%`;
    const current = links.filter((a) => (document.querySelector(a.hash)?.getBoundingClientRect().top ?? Infinity) < innerHeight * 0.4).pop();
    for (const a of links) a.classList.toggle("on", a === current);
  };
  addEventListener("scroll", update, { passive: true });
  update();
}

/** Points the download buttons at the latest release's zips. They already link to the release page if this fails. */
async function latestReleaseLinks(): Promise<void> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) return;
    const release = await response.json() as { tag_name: string; assets?: { name: string; browser_download_url: string }[] };
    const zip = (browser: string) => release.assets?.find((a) => a.name.includes(`extension-${browser}`))?.browser_download_url;
    const chrome = zip("chrome");
    const firefox = zip("firefox");
    if (chrome) $<HTMLAnchorElement>("#dl-chrome").href = chrome;
    if (firefox) $<HTMLAnchorElement>("#dl-firefox").href = firefox;
    if (chrome || firefox) {
      const note = $("#dl-note");
      note.textContent = `${release.tag_name} · Chrome, Edge, Brave and Firefox. Unzip and load it, then connect it to your own Inklayer server. `;
      const how = document.createElement("a");
      how.href = `https://github.com/${REPO}#browser-extension`;
      how.textContent = "How to install";
      note.append(how);
    }
  } catch {
    // Offline or rate-limited: the release page links still work.
  }
}
