from pathlib import Path
from PIL import Image, ImageFilter, ImageEnhance, ImageOps, ImageDraw
import textwrap

ROOT = Path('/home/user/Nova-')
ASSETS = ROOT / 'assets'
ASSETS.mkdir(exist_ok=True)

SRC = ASSETS / 'hero-lady-bg.jpg'
DESKTOP = ASSETS / 'hero-desktop.webp'
MOBILE = ASSETS / 'hero-mobile.webp'


def make_cover(im, size, top_focus=0.16):
    tw, th = size
    sw, sh = im.size
    src_ratio = sw / sh
    target_ratio = tw / th
    if src_ratio > target_ratio:
        crop_h = sh
        crop_w = int(crop_h * target_ratio)
        x = max(0, (sw - crop_w) // 2)
        y = 0
    else:
        crop_w = sw
        crop_h = int(crop_w / target_ratio)
        y = int(max(0, min(sh - crop_h, sh * top_focus)))
        x = 0
    return im.crop((x, y, x + crop_w, y + crop_h)).resize(size, Image.Resampling.LANCZOS)


def stylize_variant(size, top_focus, output):
    im = Image.open(SRC).convert('RGB')
    im = make_cover(im, size, top_focus=top_focus)
    im = ImageEnhance.Color(im).enhance(0.58)
    im = ImageEnhance.Contrast(im).enhance(0.92)
    im = ImageEnhance.Brightness(im).enhance(0.70)

    blur_bg = im.filter(ImageFilter.GaussianBlur(radius=6))
    # Blend some original detail back only near top-middle to preserve silhouette without glam focus
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((size[0]*0.18, -size[1]*0.20, size[0]*0.82, size[1]*0.82), fill=120)
    im = Image.composite(im, blur_bg, mask)

    overlay = Image.new('RGBA', size, (7, 10, 20, 0))
    px = overlay.load()
    for y in range(size[1]):
        for x in range(size[0]):
            top = 185 * (1 - y / size[1])
            bottom = 130 * (y / size[1])
            left = 45 if x < size[0] * 0.62 else 0
            right = 55 if x > size[0] * 0.72 else 0
            alpha = int(min(235, top + bottom + left + right))
            px[x, y] = (10, 12, 24, alpha)
    im = Image.alpha_composite(im.convert('RGBA'), overlay)

    vignette = Image.new('L', size, 0)
    vdraw = ImageDraw.Draw(vignette)
    vdraw.ellipse((-size[0]*0.10, -size[1]*0.05, size[0]*1.10, size[1]*1.15), fill=255)
    vignette = ImageOps.invert(vignette).filter(ImageFilter.GaussianBlur(radius=110))
    dark = Image.new('RGBA', size, (8, 10, 18, 110))
    dark.putalpha(vignette)
    im = Image.alpha_composite(im, dark)

    im.save(output, 'WEBP', quality=82, method=6)


stylize_variant((1600, 900), 0.08, DESKTOP)
stylize_variant((900, 1200), 0.05, MOBILE)

NAV = [
    ('Home', '/'),
    ('Case Review', '/confidential-case-review/'),
    ('Resources', '/survivor-resources/'),
    ('Legal Options', '/legal-options-after-rideshare-assault/'),
    ('FAQ', '/faq/'),
    ('Contact', '/contact/'),
]

PAGES = [
    {
        'slug': '',
        'title': 'Rideshare Sexual Abuse Survivor Resources',
        'eyebrow': 'Confidential survivor support',
        'description': 'Private, respectful guidance for rideshare sexual abuse and assault survivors. Learn next steps, preserve evidence, and request a confidential case review without pressure.',
        'intro': 'Built for clarity, privacy, and trust. The visual system is intentionally calm, non-graphic, and survivor-safe.',
        'chips': ['Private intake', 'Evidence guidance', 'Legal education'],
        'hero_panel_title': 'What this site helps with',
        'hero_panel_items': ['Document trip details safely', 'Review legal options at your pace', 'Find survivor-focused resources'],
        'sections': [
            ('Immediate support priorities', 'If you are in immediate danger, call 911. If you are safe now, consider preserving trip records, screenshots, receipts, app messages, and medical or counseling records in one secure place.'),
            ('Why the visuals are restrained', 'The design avoids sensational crime imagery, exploitative stock photos, and fake courtroom drama. It uses calm contrast, privacy-first cards, and supportive iconography instead.'),
        ],
        'cards': [
            ('Confidential case review', 'Talk through what happened in a private, respectful intake flow focused on facts, safety, and control.', '/confidential-case-review/'),
            ('Survivor resources', 'Find support planning, documentation help, and practical survivor-centered resources.', '/survivor-resources/'),
            ('Legal options', 'Understand claims, timelines, evidence categories, and how mass tort information may apply.', '/legal-options-after-rideshare-assault/'),
        ],
    },
    {
        'slug': 'confidential-case-review',
        'title': 'Confidential Case Review',
        'eyebrow': 'Private intake',
        'description': 'A calm, pressure-free path for sharing what happened, what documents you still have, and what questions you want answered.',
        'intro': 'Your story should not be turned into spectacle. This page keeps the visual emphasis on privacy, process, and control.',
        'chips': ['Confidential', 'No graphic content', 'Clear next steps'],
        'hero_panel_title': 'Typical intake topics',
        'hero_panel_items': ['Trip date and app platform', 'Screenshots, receipts, and route details', 'Questions about investigation and timing'],
        'sections': [
            ('Before you submit', 'Gather any rideshare receipts, trip IDs, screenshots, messages, photos of injuries if relevant, and notes about what you remember.'),
            ('What you should expect', 'A respectful review should explain legal options in plain language and never pressure you into fast decisions.'),
        ],
        'cards': [
            ('Documentation checklist', 'Keep trip receipts, app messages, screenshots, and timeline notes together in one secure folder.', '/survivor-resources/'),
            ('Legal options overview', 'Learn how evidence, deadlines, and corporate accountability claims are typically discussed.', '/legal-options-after-rideshare-assault/'),
            ('Contact page', 'Use the contact page for general questions or non-urgent outreach.', '/contact/'),
        ],
    },
    {
        'slug': 'survivor-resources',
        'title': 'Survivor Resources',
        'eyebrow': 'Supportive resources',
        'description': 'Practical guidance for preserving records, protecting privacy, seeking counseling, and understanding support options after a rideshare-related assault.',
        'intro': 'Cards on this page use neutral icons and documentation motifs rather than emotionalized photography.',
        'chips': ['Safety planning', 'Record keeping', 'Support options'],
        'hero_panel_title': 'Resource categories',
        'hero_panel_items': ['Safety and privacy', 'Trip and phone records', 'Medical and counseling support'],
        'sections': [
            ('Preserve evidence carefully', 'Save receipts, ride summaries, driver details, app support messages, screenshots, text messages, and any contemporaneous notes.'),
            ('Protect your privacy', 'Use secure storage, avoid posting details publicly, and keep a separate list of people or agencies you already contacted.'),
        ],
        'cards': [
            ('Privacy & safety', 'Steps for digital privacy, account security, and cautious information-sharing.', '/privacy-policy/'),
            ('FAQ', 'Straight answers about records, timelines, and common case questions.', '/faq/'),
            ('Mass tort information', 'Understand how broader litigation may differ from an individual case review.', '/mass-tort-information/'),
        ],
    },
    {
        'slug': 'rideshare-sexual-abuse',
        'title': 'Rideshare Sexual Abuse',
        'eyebrow': 'Educational overview',
        'description': 'An overview page explaining how rideshare sexual abuse allegations are commonly documented and why platform records can matter.',
        'intro': 'The background remains abstracted and subdued so the page stays serious, not sensational.',
        'chips': ['Platform records', 'Trip documentation', 'Respectful presentation'],
        'hero_panel_title': 'Common documentation areas',
        'hero_panel_items': ['Trip metadata', 'App communication logs', 'Post-incident notes and care'],
        'sections': [
            ('Why terminology matters', 'This page uses direct language without turning trauma into spectacle. Educational content should be plain, respectful, and actionable.'),
            ('How visuals support trust', 'Icons emphasize records, privacy, transportation, and legal process instead of dramatized danger cues.'),
        ],
        'cards': [
            ('Sexual assault page', 'See how assault-specific questions and documentation concerns are framed.', '/rideshare-sexual-assault/'),
            ('Case review', 'Move to a confidential review pathway when you want individualized guidance.', '/confidential-case-review/'),
            ('FAQ', 'Review practical questions before you contact anyone.', '/faq/'),
        ],
    },
    {
        'slug': 'rideshare-sexual-assault',
        'title': 'Rideshare Sexual Assault',
        'eyebrow': 'Plain-language information',
        'description': 'A focused page for survivors who want direct, respectful information about documentation, reporting, and next-step decision making.',
        'intro': 'The tone stays grounded and professional, with no fear-based crime-scene imagery and no manipulative stock photography.',
        'chips': ['Reporting options', 'Evidence questions', 'Respectful design'],
        'hero_panel_title': 'Common concerns',
        'hero_panel_items': ['What records still exist', 'Whether to report now or later', 'How to prepare for a review call'],
        'sections': [
            ('Immediate choices can vary', 'There is no one-size-fits-all sequence. Safety, medical needs, privacy, and emotional readiness all matter.'),
            ('Keep important text in HTML', 'Critical guidance appears as readable page text, not baked into graphics, so it stays accessible and searchable.'),
        ],
        'cards': [
            ('Legal options', 'See claim pathways, evidence themes, and timing considerations.', '/legal-options-after-rideshare-assault/'),
            ('Survivor resources', 'Find record-keeping, safety, and support reminders.', '/survivor-resources/'),
            ('Contact', 'Reach out when you need a direct line for non-urgent questions.', '/contact/'),
        ],
    },
    {
        'slug': 'legal-options-after-rideshare-assault',
        'title': 'Legal Options After Rideshare Assault',
        'eyebrow': 'Legal education',
        'description': 'A clear, non-dramatic overview of legal pathways, evidence categories, and what survivors typically want clarified before deciding what to do next.',
        'intro': 'This page avoids fake courtroom visuals and instead uses structured cards, restrained gradients, and legal-process iconography.',
        'chips': ['Legal pathways', 'Evidence categories', 'Case timing'],
        'hero_panel_title': 'Questions this page answers',
        'hero_panel_items': ['What documents matter most', 'How timing can affect claims', 'When mass tort information may be relevant'],
        'sections': [
            ('Plain-language explanations only', 'Legal information should feel steady and understandable. The layout keeps dense text broken into readable sections and supportive cards.'),
            ('No fake authority signals', 'There are no stock gavel photos, fake attorney portraits, or theatrical courthouse scenes used to manufacture trust.'),
        ],
        'cards': [
            ('Mass tort information', 'See how coordinated litigation may differ from a single claim review.', '/mass-tort-information/'),
            ('FAQ', 'Read common questions about evidence and expectations.', '/faq/'),
            ('Confidential case review', 'Use a private intake path if you want tailored guidance.', '/confidential-case-review/'),
        ],
    },
    {
        'slug': 'mass-tort-information',
        'title': 'Mass Tort Information',
        'eyebrow': 'Broader litigation context',
        'description': 'Understand the difference between individual case questions and broader mass tort or coordinated litigation information.',
        'intro': 'This page uses neutral data and process visuals so the subject feels organized rather than intimidating.',
        'chips': ['Litigation context', 'Process overview', 'Clear distinctions'],
        'hero_panel_title': 'Key distinctions',
        'hero_panel_items': ['Individual facts still matter', 'Shared allegations can exist', 'Documentation remains important'],
        'sections': [
            ('Why process clarity matters', 'Survivors often need a clean explanation of what may be shared across cases and what remains individual to their experience.'),
            ('Visual restraint supports comprehension', 'Measured spacing, icons, and contrast keep the page informative without becoming cold or corporate.'),
        ],
        'cards': [
            ('Legal options page', 'Return to the broader legal options overview.', '/legal-options-after-rideshare-assault/'),
            ('Resources page', 'Review practical record-preservation and support resources.', '/survivor-resources/'),
            ('Disclaimer', 'Read important informational-use limits for site content.', '/disclaimer/'),
        ],
    },
    {
        'slug': 'faq',
        'title': 'Frequently Asked Questions',
        'eyebrow': 'Straight answers',
        'description': 'Quick answers about rideshare records, evidence, privacy, timing, and how confidential case reviews usually work.',
        'intro': 'FAQ visuals use compact icon badges and controlled spacing to keep the page calm and readable on small screens.',
        'chips': ['Readable mobile layout', 'Accessible accordions', 'No clutter'],
        'hero_panel_title': 'FAQ themes',
        'hero_panel_items': ['Trip records', 'Privacy', 'Next-step timing'],
        'sections': [
            ('Readable by design', 'Question blocks are high-contrast, keyboard-friendly, and large enough to scan comfortably on phones and tablets.'),
            ('Avoiding clutter', 'The page limits decorative noise so the questions remain the visual priority.'),
        ],
        'cards': [
            ('Privacy policy', 'Learn how general site privacy expectations are presented.', '/privacy-policy/'),
            ('Disclaimer', 'See the information-only scope of site content.', '/disclaimer/'),
            ('Contact', 'Reach out if your question is not covered here.', '/contact/'),
        ],
        'faq': [
            ('Do I need every trip record before asking questions?', 'No. A confidential review can start with whatever you still have, including approximate dates, app receipts, screenshots, or notes.'),
            ('Should important legal guidance be inside an image?', 'No. Important guidance belongs in readable page text so it remains accessible, searchable, and easier to translate or review.'),
            ('Why does the site avoid dramatic assault imagery?', 'Because shock imagery can feel exploitative, distracting, or unsafe. Survivor-trust design should be calm, clear, and respectful.'),
        ],
    },
    {
        'slug': 'contact',
        'title': 'Contact',
        'eyebrow': 'Direct, respectful contact',
        'description': 'Use this page for non-urgent outreach, general questions, and requests to connect through a private intake process.',
        'intro': 'The contact page uses supportive cues, generous spacing, and non-threatening form styling rather than high-pressure conversion visuals.',
        'chips': ['Low-pressure', 'Readable forms', 'Supportive tone'],
        'hero_panel_title': 'Best use of this page',
        'hero_panel_items': ['General questions', 'Next-step clarification', 'Request for confidential follow-up'],
        'sections': [
            ('Respectful intake visuals', 'Fields are clearly labeled, high contrast, and sized for touch devices. No aggressive countdowns, flashing accents, or anxiety-inducing design patterns are used.'),
            ('Safety reminder', 'Do not submit sensitive information over unsecured channels if you are unsure about privacy. Keep detailed evidence in secure storage until you know how you want to share it.'),
        ],
        'cards': [
            ('Confidential case review', 'Use the structured intake pathway for case-related questions.', '/confidential-case-review/'),
            ('Survivor resources', 'Review privacy and documentation suggestions first.', '/survivor-resources/'),
            ('FAQ', 'Check common questions before reaching out.', '/faq/'),
        ],
        'contact': True,
    },
    {
        'slug': 'privacy-policy',
        'title': 'Privacy Policy',
        'eyebrow': 'Privacy and handling',
        'description': 'A readable privacy page that explains site expectations in plain language, using text-first presentation instead of visual clutter.',
        'intro': 'Even policy pages keep the same premium, accessible visual system so the site feels consistent and trustworthy.',
        'chips': ['Readable policy', 'Consistent design', 'Text-first'],
        'hero_panel_title': 'Policy priorities',
        'hero_panel_items': ['Readable structure', 'No hidden text in images', 'Clear expectations'],
        'sections': [
            ('What this page avoids', 'No dense wall-of-text styling, no low-contrast gray copy, and no decorative backgrounds that interfere with reading.'),
            ('Policy readability matters', 'Users should be able to scan headings, paragraphs, and lists comfortably on mobile and desktop without zooming.'),
        ],
        'cards': [
            ('Disclaimer', 'Read the companion information-only disclaimer.', '/disclaimer/'),
            ('Contact', 'Reach out with privacy-related questions.', '/contact/'),
            ('Home', 'Return to the main survivor resources page.', '/'),
        ],
    },
    {
        'slug': 'disclaimer',
        'title': 'Disclaimer',
        'eyebrow': 'Information-only notice',
        'description': 'Important notice about the general educational nature of site content and the need for individualized advice in real cases.',
        'intro': 'The disclaimer stays readable, restrained, and visually aligned with the rest of the site rather than looking like an afterthought.',
        'chips': ['Readable notice', 'Consistent typography', 'Clear limits'],
        'hero_panel_title': 'What this notice clarifies',
        'hero_panel_items': ['General information only', 'No guaranteed outcomes', 'Facts matter'],
        'sections': [
            ('Why the page still matters visually', 'Utility pages still influence trust. Clean spacing, consistent typography, and restrained contrast help them feel reliable and professional.'),
            ('No visual manipulation', 'The page avoids oversized fear cues, theatrical warning art, and unnecessary emotional framing.'),
        ],
        'cards': [
            ('Privacy policy', 'See how privacy expectations are explained.', '/privacy-policy/'),
            ('Legal options', 'Return to the main legal overview page.', '/legal-options-after-rideshare-assault/'),
            ('Contact', 'Reach out if you need direct clarification.', '/contact/'),
        ],
    },
]

SITE_CSS = r'''
:root {
  --bg: #07101f;
  --panel: rgba(11, 19, 34, 0.78);
  --panel-2: rgba(17, 28, 47, 0.82);
  --panel-solid: #0d182c;
  --line: rgba(188, 209, 255, 0.15);
  --line-strong: rgba(188, 209, 255, 0.24);
  --text: #eef4ff;
  --muted: #a7b6d4;
  --soft: #d8e3ff;
  --accent: #8f7dff;
  --accent-2: #4fb0ff;
  --ok: #7ce1bb;
  --max: 1180px;
  --shadow: 0 24px 70px rgba(0,0,0,.34);
  --radius: 24px;
  --radius-sm: 18px;
  --hero-image-desktop: url('/assets/hero-desktop.webp');
  --hero-image-mobile: url('/assets/hero-mobile.webp');
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font: 16px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  background:
    radial-gradient(circle at top left, rgba(117, 77, 255, 0.22), transparent 34%),
    radial-gradient(circle at top right, rgba(79, 176, 255, 0.16), transparent 24%),
    linear-gradient(180deg, #08111f 0%, #0a1324 38%, #091220 100%);
  min-width: 320px;
  overflow-x: clip;
}
a { color: inherit; text-decoration: none; }
img { max-width: 100%; display: block; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.site-shell::before,
.site-shell::after {
  content: '';
  position: fixed;
  inset: auto;
  width: 42rem;
  height: 42rem;
  border-radius: 999px;
  filter: blur(80px);
  pointer-events: none;
  z-index: -1;
}
.site-shell::before { top: -12rem; right: -10rem; background: rgba(90, 74, 255, 0.18); }
.site-shell::after { bottom: -16rem; left: -10rem; background: rgba(64, 150, 255, 0.13); }
.container { width: min(var(--max), calc(100% - 32px)); margin: 0 auto; }
.topbar {
  position: sticky; top: 0; z-index: 40;
  backdrop-filter: blur(16px);
  background: rgba(6, 12, 23, 0.72);
  border-bottom: 1px solid rgba(188, 209, 255, 0.08);
}
.nav-wrap { display:flex; align-items:center; justify-content:space-between; gap: 20px; min-height: 74px; }
.brand { display:flex; align-items:center; gap: 14px; font-weight: 700; letter-spacing: .01em; }
.brand-mark {
  width: 44px; height: 44px; border-radius: 14px; display:grid; place-items:center;
  background: linear-gradient(135deg, rgba(143,125,255,.42), rgba(79,176,255,.30));
  border: 1px solid rgba(255,255,255,.12);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
}
.brand-mark svg { width: 22px; height: 22px; }
.brand-copy small { display:block; color: var(--muted); font-weight: 600; font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; }
.brand-copy span { display:block; font-size: .98rem; }
.nav-links { display:flex; flex-wrap: wrap; gap: 10px; justify-content:flex-end; }
.nav-links a {
  padding: 10px 14px; border-radius: 999px; color: var(--muted); font-size: .94rem; font-weight: 600;
  transition: .2s ease;
}
.nav-links a:hover, .nav-links a[aria-current="page"] {
  color: var(--text); background: rgba(255,255,255,.06); box-shadow: inset 0 0 0 1px rgba(255,255,255,.07);
}
.hero { padding: 34px 0 32px; }
.hero-card {
  position: relative; overflow: clip; border-radius: calc(var(--radius) + 6px);
  border: 1px solid var(--line); background: linear-gradient(180deg, rgba(10, 19, 34, 0.86), rgba(10, 16, 29, 0.92));
  box-shadow: var(--shadow);
}
.hero-card::before {
  content: ''; position: absolute; inset: 0; background: var(--hero-image-desktop) center top / cover no-repeat;
  opacity: .48; z-index: 0;
}
.hero-card::after {
  content: ''; position: absolute; inset: 0; z-index: 0;
  background:
    linear-gradient(90deg, rgba(6, 13, 25, .96) 0%, rgba(7, 14, 26, .84) 42%, rgba(7, 14, 26, .42) 72%, rgba(7, 14, 26, .78) 100%),
    linear-gradient(180deg, rgba(12, 22, 39, .20), rgba(6, 12, 23, .76));
}
.hero-grid {
  position: relative; z-index: 1; display:grid; grid-template-columns: minmax(0, 1.2fr) minmax(290px, .8fr);
  gap: 26px; padding: clamp(28px, 4vw, 54px);
}
.eyebrow {
  display:inline-flex; align-items:center; gap: 10px; color: var(--soft); font-size: .82rem; font-weight: 700;
  letter-spacing: .11em; text-transform: uppercase; padding: 10px 14px; border-radius: 999px;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08);
}
.eyebrow::before { content:''; width:9px; height:9px; border-radius:50%; background: linear-gradient(180deg, #8f7dff, #4fb0ff); box-shadow: 0 0 0 5px rgba(143,125,255,.14); }
.hero h1 { font-size: clamp(2.1rem, 5vw, 4.3rem); line-height: 1.03; margin: 18px 0 14px; max-width: 12ch; }
.hero p.lead { max-width: 62ch; color: var(--soft); font-size: clamp(1.02rem, 1.5vw, 1.14rem); }
.hero .hero-intro { margin-top: 16px; color: var(--muted); max-width: 58ch; }
.chip-row { display:flex; flex-wrap:wrap; gap: 12px; margin-top: 22px; }
.chip {
  padding: 10px 14px; border-radius: 999px; font-weight: 600; font-size: .92rem;
  border: 1px solid rgba(255,255,255,.09); background: rgba(8,16,29,.46); color: var(--soft);
}
.hero-actions { display:flex; flex-wrap:wrap; gap: 12px; margin-top: 26px; }
.btn {
  display:inline-flex; align-items:center; justify-content:center; gap: 10px; min-height: 50px; padding: 0 18px;
  border-radius: 14px; border: 1px solid transparent; font-weight: 700; font-size: .96rem; transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}
.btn:hover { transform: translateY(-1px); }
.btn-primary {
  color: #fff; background: linear-gradient(135deg, #7d69ff, #4ea7ff); box-shadow: 0 14px 36px rgba(79,176,255,.24);
}
.btn-secondary { color: var(--text); background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.08); }
.panel {
  backdrop-filter: blur(18px); background: linear-gradient(180deg, rgba(14, 24, 40, .82), rgba(10, 18, 31, .80));
  border: 1px solid rgba(255,255,255,.10); border-radius: 22px; padding: 22px; align-self: end;
}
.panel h2, .panel h3 { margin: 0 0 12px; font-size: 1.15rem; }
.panel ul { list-style:none; padding:0; margin: 12px 0 0; display:grid; gap: 12px; }
.panel li {
  display:flex; gap: 12px; align-items:flex-start; color: var(--soft); background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.06); border-radius: 16px; padding: 14px;
}
.panel li::before {
  content: ''; flex: 0 0 11px; width: 11px; height: 11px; margin-top: .45rem; border-radius: 50%;
  background: linear-gradient(180deg, #7ce1bb, #4fb0ff); box-shadow: 0 0 0 6px rgba(124,225,187,.08);
}
.metrics { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }
.metric {
  padding: 16px; border-radius: 18px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.06);
}
.metric strong { display:block; font-size: 1.24rem; line-height: 1; }
.metric span { color: var(--muted); font-size: .88rem; }
.section { padding: 20px 0 8px; }
.section-head { display:flex; align-items:end; justify-content:space-between; gap: 20px; margin-bottom: 18px; }
.section-head h2 { font-size: clamp(1.45rem, 2vw, 2rem); margin: 0; }
.section-head p { margin: 0; max-width: 62ch; color: var(--muted); }
.content-grid { display:grid; grid-template-columns: 1.1fr .9fr; gap: 20px; }
.copy-card, .side-card, .link-card, .contact-card, .faq-item, .policy-card {
  background: linear-gradient(180deg, var(--panel), var(--panel-2)); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow);
}
.copy-card, .side-card, .contact-card, .policy-card { padding: clamp(20px, 2.6vw, 28px); }
.copy-card p, .side-card p, .policy-card p { color: var(--soft); margin: 0 0 14px; }
.copy-card h3, .side-card h3, .policy-card h3 { margin: 0 0 12px; font-size: 1.15rem; }
.icon-list { list-style:none; padding:0; margin: 18px 0 0; display:grid; gap: 14px; }
.icon-list li { display:grid; grid-template-columns: 44px 1fr; gap: 14px; align-items:flex-start; }
.icon-badge {
  width: 44px; height: 44px; border-radius: 14px; display:grid; place-items:center;
  background: linear-gradient(180deg, rgba(143,125,255,.20), rgba(79,176,255,.16)); border: 1px solid rgba(255,255,255,.08);
}
.icon-badge svg { width: 22px; height: 22px; }
.card-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.link-card {
  padding: 22px; position: relative; overflow:hidden;
}
.link-card::after {
  content:''; position:absolute; inset:auto -20% -30% auto; width:120px; height:120px; border-radius:50%; filter: blur(18px);
  background: radial-gradient(circle, rgba(79,176,255,.16), transparent 72%);
}
.link-card .kicker { display:inline-flex; font-size:.74rem; letter-spacing:.08em; text-transform:uppercase; color: var(--muted); font-weight:700; margin-bottom: 12px; }
.link-card h3 { margin: 0 0 10px; font-size: 1.15rem; }
.link-card p { margin: 0 0 18px; color: var(--soft); }
.link-card a {
  display:inline-flex; align-items:center; gap:10px; color: #bcd7ff; font-weight:700;
}
.link-card a svg { width: 16px; height: 16px; }
.cta-band {
  margin: 28px 0 10px; padding: 22px 24px; display:grid; grid-template-columns: 1fr auto; gap: 18px; align-items:center;
  border-radius: var(--radius); border: 1px solid rgba(255,255,255,.08);
  background: linear-gradient(135deg, rgba(124,225,187,.10), rgba(79,176,255,.10), rgba(143,125,255,.14));
}
.cta-band strong { display:block; font-size: 1.15rem; }
.cta-band span { color: var(--muted); }
.faq-grid { display:grid; gap: 14px; }
.faq-item { overflow:hidden; }
.faq-toggle {
  width:100%; background:none; color: var(--text); border:0; font: inherit; text-align:left; cursor:pointer;
  display:flex; justify-content:space-between; align-items:center; gap: 16px; padding: 20px 22px;
}
.faq-toggle span { font-weight: 700; }
.faq-toggle svg { width: 18px; height: 18px; color: var(--muted); transition: transform .2s ease; }
.faq-item[open] .faq-toggle svg { transform: rotate(180deg); }
.faq-body { padding: 0 22px 20px; color: var(--soft); }
.contact-grid { display:grid; grid-template-columns: 1fr .9fr; gap: 18px; }
.form-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.field { display:grid; gap: 8px; }
.field.full { grid-column: 1 / -1; }
label { color: var(--soft); font-weight: 600; font-size: .92rem; }
input, textarea {
  width:100%; border-radius: 14px; border: 1px solid rgba(255,255,255,.10);
  background: rgba(4, 10, 20, .44); color: var(--text); padding: 14px 16px; font: inherit;
}
textarea { min-height: 132px; resize: vertical; }
.policy-card ul { margin: 10px 0 0; padding-left: 18px; color: var(--soft); }
.notice {
  padding: 14px 16px; border-radius: 16px; background: rgba(124,225,187,.08); color: var(--soft); border: 1px solid rgba(124,225,187,.18);
}
.footer { padding: 34px 0 46px; color: var(--muted); }
.footer-card {
  display:flex; flex-wrap:wrap; justify-content:space-between; gap: 16px; align-items:center; padding: 18px 20px;
  border-radius: 22px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.03);
}
.footer-links { display:flex; flex-wrap:wrap; gap: 14px; }
.footer-links a { color: var(--muted); }
.footer-links a:hover { color: var(--text); }
@media (max-width: 1080px) {
  .hero-grid, .content-grid, .contact-grid { grid-template-columns: 1fr; }
  .card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 820px) {
  .nav-wrap { padding: 10px 0; align-items:flex-start; }
  .nav-links { width:100%; justify-content:flex-start; }
  .hero-card::before { background-image: var(--hero-image-mobile); background-position: center top; opacity: .4; }
  .hero-card::after { background: linear-gradient(180deg, rgba(6, 12, 23, .74) 0%, rgba(6, 12, 23, .82) 28%, rgba(6, 12, 23, .94) 100%); }
  .metrics { grid-template-columns: 1fr; }
  .card-grid, .contact-grid { grid-template-columns: 1fr; }
  .cta-band { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .container { width: min(var(--max), calc(100% - 20px)); }
  .hero-grid { padding: 22px 18px; }
  .chip-row, .hero-actions { gap: 10px; }
  .card-grid { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
  .hero h1 { max-width: none; }
  .nav-links a { padding: 8px 11px; font-size: .9rem; }
}
'''

SITE_JS = r'''
document.querySelectorAll('.faq-item').forEach((item) => {
  const btn = item.querySelector('.faq-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    item.toggleAttribute('open');
    btn.setAttribute('aria-expanded', item.hasAttribute('open') ? 'true' : 'false');
  });
});
'''

ICON = {
    'shield': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3l7 3v5c0 4.7-2.9 8.7-7 10-4.1-1.3-7-5.3-7-10V6l7-3z"/><path d="M9.3 12.2l1.8 1.8 3.8-4.3"/></svg>',
    'docs': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 3h6l5 5v13H8z"/><path d="M14 3v5h5"/><path d="M11 13h5M11 17h5M11 9h1"/></svg>',
    'ride': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 16l1.5-5A3 3 0 0 1 9.4 9h5.2a3 3 0 0 1 2.9 2L19 16"/><path d="M4 16h16"/><path d="M7 16v3M17 16v3"/><circle cx="8" cy="13" r="1"/><circle cx="16" cy="13" r="1"/></svg>',
    'chat': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 17l-3 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7z"/><path d="M8 9h8M8 13h5"/></svg>',
    'arrow': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg>',
    'lock': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    'mail': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h16v12H4z"/><path d="M4 8l8 6 8-6"/></svg>',
    'faq': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-.7.9-2 1.4-2 2.8"/><circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none"/></svg>',
    'chev': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
}


def nav_html(current_slug):
    items = []
    current_path = '/' if current_slug == '' else f'/{current_slug}/'
    for label, href in NAV:
        aria = ' aria-current="page"' if href == current_path else ''
        items.append(f'<a href="{href}"{aria}>{label}</a>')
    return ''.join(items)


def card(title, text, href):
    return f'''
    <article class="link-card">
      <span class="kicker">Helpful path</span>
      <h3>{title}</h3>
      <p>{text}</p>
      <a href="{href}">Open page {ICON['arrow']}</a>
    </article>
    '''


def icon_list(page):
    items = [
        ('Privacy-first presentation', 'Calm gradients, softened background treatment, and strong contrast improve trust without sensationalism.', 'shield'),
        ('Page-matched visual cues', 'Icons emphasize safety, records, communication, and legal process so visuals match the page topic.', 'docs'),
        ('Mobile-safe composition', 'Cards, forms, and hero copy stay balanced across phone, tablet, and desktop widths.', 'ride'),
    ]
    if page.get('slug') == 'contact':
        items[2] = ('Readable outreach flow', 'The contact form uses large targets, clear labels, and no manipulative urgency.', 'mail')
    if page.get('slug') == 'faq':
        items[1] = ('Accessible disclosure blocks', 'Questions stay readable and expandable without hiding critical information in graphics.', 'faq')
    return '\n'.join(
        f'''<li><span class="icon-badge">{ICON[key]}</span><div><strong>{title}</strong><p>{desc}</p></div></li>'''
        for title, desc, key in items
    )


def faq_html(page):
    faqs = page.get('faq') or []
    if not faqs:
        return ''
    blocks = []
    for q, a in faqs:
        blocks.append(f'''
        <article class="faq-item">
          <button class="faq-toggle" type="button" aria-expanded="false">
            <span>{q}</span>{ICON['chev']}
          </button>
          <div class="faq-body">{a}</div>
        </article>
        ''')
    return f'''
    <section class="section">
      <div class="container">
        <div class="section-head">
          <h2>Common questions</h2>
          <p>Important answers remain in live HTML text for accessibility and search clarity.</p>
        </div>
        <div class="faq-grid">{''.join(blocks)}</div>
      </div>
    </section>
    '''


def contact_html(page):
    if not page.get('contact'):
        return ''
    return f'''
    <section class="section">
      <div class="container contact-grid">
        <article class="contact-card">
          <div class="section-head" style="margin-bottom:16px;">
            <h2>Contact form preview</h2>
            <p>Designed for clarity, touch usability, and low-pressure outreach.</p>
          </div>
          <form class="form-grid" action="#" method="post" novalidate>
            <div class="field"><label for="name">Name</label><input id="name" name="name" autocomplete="name" placeholder="Your name"></div>
            <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com"></div>
            <div class="field"><label for="phone">Phone</label><input id="phone" name="phone" autocomplete="tel" placeholder="Optional"></div>
            <div class="field"><label for="topic">Topic</label><input id="topic" name="topic" placeholder="General question or confidential follow-up"></div>
            <div class="field full"><label for="message">Message</label><textarea id="message" name="message" placeholder="Share only what feels comfortable right now."></textarea></div>
            <div class="field full"><button class="btn btn-primary" type="button">Request follow-up</button></div>
          </form>
        </article>
        <aside class="side-card">
          <h3>Contact reminders</h3>
          <p>Use non-urgent channels for general questions. Keep detailed evidence in secure storage until you know where and how you want to share it.</p>
          <div class="notice">If you are in immediate danger, call 911. This site design prioritizes readable information and low-pressure contact pathways.</div>
          <ul class="icon-list">{icon_list(page)}</ul>
        </aside>
      </div>
    </section>
    '''


def policy_html(page):
    if page['slug'] not in ('privacy-policy', 'disclaimer'):
        return ''
    title = 'Policy highlights' if page['slug'] == 'privacy-policy' else 'Important notice'
    points = [
        'This site presents general educational information in readable HTML text.',
        'Critical guidance is not hidden inside images or decorative graphics.',
        'Policies and notices use the same high-contrast visual language as the rest of the site.',
    ]
    if page['slug'] == 'disclaimer':
        points = [
            'Site content is general information only and not a promise of case outcomes.',
            'Individual facts, documents, timing, and jurisdictional issues can matter.',
            'The page intentionally avoids theatrical warning imagery and focuses on readable notice text.',
        ]
    lis = ''.join(f'<li>{p}</li>' for p in points)
    return f'''
    <section class="section">
      <div class="container">
        <article class="policy-card">
          <h2>{title}</h2>
          <p>{page['description']}</p>
          <ul>{lis}</ul>
        </article>
      </div>
    </section>
    '''


def render(page):
    slug = page['slug']
    path_prefix = '/' if slug == '' else f'/{slug}/'
    sections_html = ''.join(
        f'<article class="copy-card"><h3>{title}</h3><p>{body}</p></article>'
        for title, body in page['sections']
    )
    cards_html = ''.join(card(*c) for c in page['cards'])
    chips = ''.join(f'<span class="chip">{chip}</span>' for chip in page['chips'])
    hero_items = ''.join(f'<li>{item}</li>' for item in page['hero_panel_items'])
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{page['title']} | Survivor-Safe Rideshare Resource</title>
  <meta name="description" content="{page['description']}">
  <meta name="theme-color" content="#091220">
  <link rel="preload" href="/assets/hero-desktop.webp" as="image" type="image/webp" fetchpriority="high">
  <link rel="preload" href="/assets/hero-mobile.webp" as="image" type="image/webp" media="(max-width: 820px)" fetchpriority="high">
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <div class="site-shell">
    <header class="topbar">
      <div class="container nav-wrap">
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true">{ICON['shield']}</span>
          <span class="brand-copy"><small>Survivor-safe design</small><span>Rideshare Resource Center</span></span>
        </a>
        <nav class="nav-links" aria-label="Primary navigation">{nav_html(slug)}</nav>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="container">
          <div class="hero-card">
            <div class="hero-grid">
              <div>
                <span class="eyebrow">{page['eyebrow']}</span>
                <h1>{page['title']}</h1>
                <p class="lead">{page['description']}</p>
                <p class="hero-intro">{page['intro']}</p>
                <div class="chip-row">{chips}</div>
                <div class="hero-actions">
                  <a class="btn btn-primary" href="/confidential-case-review/">Start confidential review</a>
                  <a class="btn btn-secondary" href="/survivor-resources/">View survivor resources</a>
                </div>
                <div class="metrics" aria-label="Trust metrics">
                  <div class="metric"><strong>Private</strong><span>Calm visual hierarchy</span></div>
                  <div class="metric"><strong>Readable</strong><span>Text-first guidance</span></div>
                  <div class="metric"><strong>Responsive</strong><span>Balanced across devices</span></div>
                </div>
              </div>
              <aside class="panel">
                <h2>{page['hero_panel_title']}</h2>
                <ul>{hero_items}</ul>
              </aside>
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-head">
            <h2>Visual approach</h2>
            <p>Every page uses survivor-safe composition: softened imagery, strong readability, restrained motion, and icons that match the information being presented.</p>
          </div>
          <div class="content-grid">
            <div>{sections_html}</div>
            <aside class="side-card">
              <h3>Why this design works</h3>
              <p>The softened background retains a human presence without using exploitative or glamour-forward framing. Structured cards and accessible contrast keep attention on support and education.</p>
              <ul class="icon-list">{icon_list(page)}</ul>
            </aside>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-head">
            <h2>Next steps</h2>
            <p>These cards are visually matched to their purpose so they do not feel random, generic, or emotionally off-tone.</p>
          </div>
          <div class="card-grid">{cards_html}</div>
          <div class="cta-band">
            <div>
              <strong>Need a private starting point?</strong>
              <span>Use the confidential case review page for a calm, information-first intake pathway.</span>
            </div>
            <a class="btn btn-primary" href="/confidential-case-review/">Open case review</a>
          </div>
        </div>
      </section>

      {faq_html(page)}
      {contact_html(page)}
      {policy_html(page)}
    </main>

    <footer class="footer">
      <div class="container footer-card">
        <div>
          <strong>Survivor-safe rideshare resource design</strong>
          <div>Calm visuals. Clear text. Respectful presentation.</div>
        </div>
        <nav class="footer-links" aria-label="Footer navigation">
          <a href="/privacy-policy/">Privacy policy</a>
          <a href="/disclaimer/">Disclaimer</a>
          <a href="/faq/">FAQ</a>
          <a href="/contact/">Contact</a>
        </nav>
      </div>
    </footer>
  </div>
  <script src="/assets/site.js" defer></script>
</body>
</html>
'''
    target_dir = ROOT if slug == '' else ROOT / slug
    target_dir.mkdir(exist_ok=True)
    (target_dir / 'index.html').write_text(html, encoding='utf-8')


(ASSETS / 'site.css').write_text(SITE_CSS, encoding='utf-8')
(ASSETS / 'site.js').write_text(SITE_JS, encoding='utf-8')
for page in PAGES:
    render(page)

# lightweight root redirect helper file for environments that prefer explicit default docs
(ROOT / 'index.html').write_text((ROOT / 'index.html').read_text(encoding='utf-8'), encoding='utf-8')
print('Built survivor-safe site with', len(PAGES), 'pages')
