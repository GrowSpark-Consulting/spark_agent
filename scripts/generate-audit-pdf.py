import os
import sys
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether, HRFlowable
)
from reportlab.pdfgen import canvas

class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, page_count):
        self.saveState()
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#64748b"))
        
        # Header (pages > 1)
        if self._pageNumber > 1:
            self.drawString(54, 750, "Pakka Agent — Production Environment & Crash Audit Report")
            self.drawRightString(612 - 54, 750, "Release Candidate v1.0.0-rc1")
            self.setStrokeColor(colors.HexColor("#cbd5e1"))
            self.setLineWidth(0.5)
            self.line(54, 744, 612 - 54, 744)

        # Footer (all pages)
        self.setStrokeColor(colors.HexColor("#cbd5e1"))
        self.setLineWidth(0.5)
        self.line(54, 45, 612 - 54, 45)
        self.drawString(54, 32, "CONFIDENTIAL — FOR INTERNAL TEAM & RAJA ONLY")
        self.drawRightString(612 - 54, 32, f"Page {self._pageNumber} of {page_count}")
        self.restoreState()

def build_pdf(filename):
    doc = SimpleDocTemplate(
        filename,
        pagesize=letter,
        leftMargin=40,
        rightMargin=40,
        topMargin=54,
        bottomMargin=54
    )
    
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=24,
        textColor=colors.HexColor('#0f172a'),
        spaceAfter=4
    )
    
    subtitle_style = ParagraphStyle(
        'DocSubTitle',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=10,
        leading=14,
        textColor=colors.HexColor('#475569'),
        spaceAfter=15
    )
    
    h1_style = ParagraphStyle(
        'SecH1',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=13,
        leading=16,
        textColor=colors.HexColor('#0f766e'),
        spaceBefore=14,
        spaceAfter=6,
        keepWithNext=True
    )

    h2_style = ParagraphStyle(
        'SecH2',
        parent=styles['Heading3'],
        fontName='Helvetica-Bold',
        fontSize=10.5,
        leading=14,
        textColor=colors.HexColor('#1e293b'),
        spaceBefore=8,
        spaceAfter=4,
        keepWithNext=True
    )
    
    body_style = ParagraphStyle(
        'DocBody',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=8.5,
        leading=12,
        textColor=colors.HexColor('#334155'),
        spaceAfter=6
    )

    body_bold = ParagraphStyle(
        'DocBodyBold',
        parent=body_style,
        fontName='Helvetica-Bold'
    )

    callout_style = ParagraphStyle(
        'Callout',
        parent=styles['Normal'],
        fontName='Helvetica-Oblique',
        fontSize=8.5,
        leading=12,
        textColor=colors.HexColor('#0f766e')
    )

    th_style = ParagraphStyle(
        'TableHeader',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=7.5,
        leading=9.5,
        textColor=colors.white,
        alignment=0
    )

    td_style = ParagraphStyle(
        'TableCell',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=7,
        leading=9,
        textColor=colors.HexColor('#1e293b')
    )

    td_code = ParagraphStyle(
        'TableCellCode',
        parent=styles['Normal'],
        fontName='Courier',
        fontSize=6.5,
        leading=8.5,
        textColor=colors.HexColor('#0f172a')
    )
    
    td_status_ok = ParagraphStyle(
        'StatusOk', parent=td_style, fontName='Helvetica-Bold', textColor=colors.HexColor('#15803d')
    )
    td_status_warn = ParagraphStyle(
        'StatusWarn', parent=td_style, fontName='Helvetica-Bold', textColor=colors.HexColor('#b45309')
    )
    td_status_crit = ParagraphStyle(
        'StatusCrit', parent=td_style, fontName='Helvetica-Bold', textColor=colors.HexColor('#b91c1c')
    )

    story = []

    # Title block
    story.append(Paragraph("Pakka Agent — Production Environment & Crash Audit", title_style))
    story.append(Paragraph("<b>Role:</b> Senior Backend Engineer & Reliability Lead (Dev 2) | <b>Audience:</b> Raja & Team | <b>Target:</b> v1.0.0-rc1", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor('#0f766e'), spaceAfter=12))

    # SECTION A: EXECUTIVE SUMMARY
    story.append(Paragraph("A. Executive Summary", h1_style))
    story.append(Paragraph(
        "A rigorous, read-only audit of the entire Pakka Agent repository was conducted, spanning backend initialization "
        "(<code>backend/src/server/main.ts</code>), environment schema parsing (<code>backend/src/lib/env.ts</code>), "
        "Next.js frontend configuration, Railway deployment specifications (<code>railway.json</code>), "
        "Supabase RLS policies (migrations <code>0001-0052</code>), and 28 Inngest background functions. "
        "The codebase typechecks cleanly and passes all 421 core tests, but <b>critical credential omissions in environment files "
        "will cause immediate boot crashes and payment failures if pushed directly to production without remediation.</b>",
        body_style
    ))
    
    summary_data = [
        [Paragraph("<b>Audit Dimension</b>", th_style), Paragraph("<b>Status</b>", th_style), Paragraph("<b>Key Finding / Production Impact</b>", th_style)],
        [Paragraph("Process Boot (Railway)", td_style), Paragraph("CRITICAL RISK", td_status_crit), Paragraph("<code>ANTHROPIC_API_KEY</code> commented in local env; DB pre-sync dependency causes boot crash if DB unreachable.", td_style)],
        [Paragraph("Browser Client (Vercel)", td_style), Paragraph("BROKEN (DEV)", td_status_crit), Paragraph("<code>NEXT_PUBLIC_API_URL</code> missing in frontend env; all browser API calls throw missing URL error.", td_style)],
        [Paragraph("Payments (PayU)", td_style), Paragraph("TEST MODE ONLY", td_status_warn), Paragraph("Runs on PayU Sandbox (`PAYU_MODE=test`); live key/salt and auto-debit SI mandates pending from Raja.", td_style)],
        [Paragraph("WhatsApp Integration", td_style), Paragraph("READY FOR LIVE", td_status_ok), Paragraph("Webhook handshake & HMAC-SHA256 signature verification cryptographically verified; needs Meta app link.", td_style)],
        [Paragraph("Inngest Background Jobs", td_style), Paragraph("28/28 TESTED", td_status_ok), Paragraph("All 8 crons & 20 event workflows tested; production endpoint sync required on deploy.", td_style)],
        [Paragraph("Redis & Caching", td_style), Paragraph("NOT USED", td_status_ok), Paragraph("Zero Redis dependencies in codebase; Postgres locks and Inngest durable queues handle state.", td_style)],
        [Paragraph("Token Encryption", td_style), Paragraph("UNVERIFIED KEY", td_status_warn), Paragraph("AES-256-GCM encryption active; distinct 32-byte production key must be created via openssl.", td_style)]
    ]
    t_summary = Table(summary_data, colWidths=[120, 90, 322])
    t_summary.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1e293b')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cbd5e1')),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#f8fafc'), colors.white]),
    ]))
    story.append(t_summary)
    story.append(Spacer(1, 10))

    # SECTION B: ENVIRONMENT VARIABLE MATRIX
    story.append(Paragraph("B. Environment Variable Inventory & Classification", h1_style))
    story.append(Paragraph("Every environment variable referenced across the frontend and backend runtime execution paths:", body_style))

    env_data = [
        [Paragraph("<b>Variable</b>", th_style), Paragraph("<b>Required For</b>", th_style), Paragraph("<b>Host</b>", th_style), Paragraph("<b>Scope</b>", th_style), Paragraph("<b>Current Status</b>", th_style)],
        [Paragraph("<code>NEXT_PUBLIC_APP_URL</code>", td_code), Paragraph("Frontend origin & CORS check", td_style), Paragraph("Railway & Vercel", td_style), Paragraph("Public", td_style), Paragraph("PRESENT (UNVERIFIED)", td_status_warn)],
        [Paragraph("<code>NEXT_PUBLIC_API_URL</code>", td_code), Paragraph("Browser API caller base URL", td_style), Paragraph("Vercel", td_style), Paragraph("Public", td_style), Paragraph("MISSING IN FRONTEND ENV", td_status_crit)],
        [Paragraph("<code>API_PUBLIC_URL</code>", td_code), Paragraph("Public API origin for PayU return", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("REQUIRED FOR BILLING", td_status_crit)],
        [Paragraph("<code>CORS_ALLOWED_ORIGINS</code>", td_code), Paragraph("Extra origins whitelist", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("PRESENT & VERIFIED", td_status_ok)],
        [Paragraph("<code>NEXT_PUBLIC_SUPABASE_URL</code>", td_code), Paragraph("Supabase project REST/Auth URL", td_style), Paragraph("Both", td_style), Paragraph("Public", td_style), Paragraph("PRESENT & VERIFIED", td_status_ok)],
        [Paragraph("<code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>", td_code), Paragraph("Client Auth & RLS queries", td_style), Paragraph("Both", td_style), Paragraph("Public", td_style), Paragraph("PRESENT & VERIFIED", td_status_ok)],
        [Paragraph("<code>SUPABASE_SERVICE_ROLE_KEY</code>", td_code), Paragraph("DB Admin, Storage, Background", td_style), Paragraph("Railway (ONLY)", td_style), Paragraph("SECRET", td_style), Paragraph("LEAKED IN FRONTEND ENV", td_status_crit)],
        [Paragraph("<code>ANTHROPIC_API_KEY</code>", td_code), Paragraph("Claude 3.5 Sonnet & Haiku", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("COMMENTED OUT / CRASH", td_status_crit)],
        [Paragraph("<code>EMBEDDINGS_API_KEY</code>", td_code), Paragraph("Voyage-4 Vector Embeddings", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("PRESENT & VERIFIED", td_status_ok)],
        [Paragraph("<code>EMBEDDINGS_BASE_URL</code>", td_code), Paragraph("Atlas endpoint (voyage-4)", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("PRESENT & VERIFIED", td_status_ok)],
        [Paragraph("<code>ENCRYPTION_KEY</code>", td_code), Paragraph("AES-256-GCM tokens at rest", td_style), Paragraph("Railway (ONLY)", td_style), Paragraph("SECRET", td_style), Paragraph("PRESENT (NEEDS PROD KEY)", td_status_warn)],
        [Paragraph("<code>PAYU_MERCHANT_KEY</code>", td_code), Paragraph("PayU Merchant identifier", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("TEST KEY PRESENT", td_status_warn)],
        [Paragraph("<code>PAYU_MERCHANT_SALT</code>", td_code), Paragraph("PayU SHA-512 signing salt", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("TEST SALT PRESENT", td_status_warn)],
        [Paragraph("<code>PAYU_MODE</code>", td_code), Paragraph("Switch ('test' vs 'live')", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("PRESENT ('test')", td_status_ok)],
        [Paragraph("<code>META_APP_SECRET</code>", td_code), Paragraph("Webhook HMAC-SHA256 sign", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("PRESENT & VERIFIED", td_status_ok)],
        [Paragraph("<code>META_WEBHOOK_VERIFY_TOKEN</code>", td_code), Paragraph("GET challenge verification", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("PRESENT & VERIFIED", td_status_ok)],
        [Paragraph("<code>META_SYSTEM_USER_TOKEN</code>", td_code), Paragraph("Meta Graph API Admin token", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("PRESENT (UNVERIFIED)", td_status_warn)],
        [Paragraph("<code>WHATSAPP_DEMO_WABA_ID</code>", td_code), Paragraph("Demo WABA Account ID", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("PRESENT", td_status_ok)],
        [Paragraph("<code>WHATSAPP_DEMO_PHONE_NUMBER_ID</code>", td_code), Paragraph("Demo WhatsApp Phone ID", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("PRESENT", td_status_ok)],
        [Paragraph("<code>GOOGLE_CLIENT_ID</code> / <code>SECRET</code>", td_code), Paragraph("Staff Google Calendar OAuth", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("MISSING (EMPTY STRINGS)", td_status_crit)],
        [Paragraph("<code>GOOGLE_REDIRECT_URI</code>", td_code), Paragraph("OAuth callback endpoint", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("MISCONFIGURED (LOCALHOST)", td_status_crit)],
        [Paragraph("<code>INNGEST_EVENT_KEY</code>", td_code), Paragraph("Inngest event dispatcher key", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("PRESENT", td_status_ok)],
        [Paragraph("<code>INNGEST_SIGNING_KEY</code>", td_code), Paragraph("Inngest webhook signature key", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("PRESENT", td_status_ok)],
        [Paragraph("<code>INNGEST_SERVE_ORIGIN</code>", td_code), Paragraph("Inngest callback host override", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("MISSING (RECOMMENDED)", td_status_warn)],
        [Paragraph("<code>SENTRY_DSN</code>", td_code), Paragraph("Direct envelope error reporting", td_style), Paragraph("Railway", td_style), Paragraph("Public", td_style), Paragraph("OPTIONAL / UNSET", td_status_warn)],
        [Paragraph("<code>LANGFUSE_PUBLIC_KEY</code> / <code>SECRET</code>", td_code), Paragraph("LLM tracing & token counts", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("OPTIONAL / UNSET", td_status_ok)],
        [Paragraph("<code>RESEND_API_KEY</code>", td_code), Paragraph("Transactional email dispatch", td_style), Paragraph("Railway", td_style), Paragraph("SECRET", td_style), Paragraph("NOT REQUIRED (DAY 9)", td_status_ok)],
        [Paragraph("<code>REDIS_URL</code>", td_code), Paragraph("In-memory cache/queues", td_style), Paragraph("None", td_style), Paragraph("N/A", td_style), Paragraph("NOT USED IN REPO", td_status_ok)],
    ]
    t_env = Table(env_data, colWidths=[130, 130, 95, 55, 122])
    t_env.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1e293b')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cbd5e1')),
        ('TOPPADDING', (0,0), (-1,-1), 2.5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2.5),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#f8fafc'), colors.white]),
    ]))
    story.append(t_env)
    story.append(Spacer(1, 10))

    # SECTION C: CRASH & ERROR REPORT
    story.append(Paragraph("C. Crash and Error Report", h1_style))
    crash_data = [
        [Paragraph("<b>Issue & Symptom</b>", th_style), Paragraph("<b>Root Cause</b>", th_style), Paragraph("<b>Sev</b>", th_style), Paragraph("<b>Affected Area</b>", th_style), Paragraph("<b>Required Fix</b>", th_style)],
        [
            Paragraph("<b>Backend Boot Crash</b><br/><code>EnvError: ANTHROPIC_API_KEY is required</code>", td_style),
            Paragraph("Variable commented out in <code>backend/.env.local</code> line 16.", td_style),
            Paragraph("P0", td_status_crit),
            Paragraph("Backend API startup", td_style),
            Paragraph("Uncomment & provide key in local; ensure set in Railway.", td_style)
        ],
        [
            Paragraph("<b>Client API Rejection</b><br/><code>NEXT_PUBLIC_API_URL is required</code>", td_style),
            Paragraph("Omitted from <code>frontend/.env.local</code>; <code>parseApiUrl</code> throws on blank.", td_style),
            Paragraph("P1", td_status_crit),
            Paragraph("All dashboard data reads", td_style),
            Paragraph("Set <code>NEXT_PUBLIC_API_URL</code> on Vercel to Railway domain.", td_style)
        ],
        [
            Paragraph("<b>Payment Checkout Refusal</b><br/><code>503 not_available: Payments aren't switched on</code>", td_style),
            Paragraph("<code>checkout.ts:67</code> demands <code>API_PUBLIC_URL</code> to build return path.", td_style),
            Paragraph("P1", td_status_crit),
            Paragraph("Plan upgrade & top-ups", td_style),
            Paragraph("Add <code>API_PUBLIC_URL=https://api.pakkaagent.in</code> to Railway.", td_style)
        ],
        [
            Paragraph("<b>Deploy Timeout Risk</b><br/>Railway healthcheck 60s timeout", td_style),
            Paragraph("<code>syncPacks()</code> blocks server listen before DB is confirmed ready.", td_style),
            Paragraph("P1", td_status_warn),
            Paragraph("Deployment availability", td_style),
            Paragraph("Ensure DB is online before Railway deploy; migrations run first.", td_style)
        ],
        [
            Paragraph("<b>Google Calendar Connect Error</b><br/><code>503 not_available: Google Calendar isn't on</code>", td_style),
            Paragraph("<code>GOOGLE_CLIENT_ID</code> is empty string in config.", td_style),
            Paragraph("P2", td_status_warn),
            Paragraph("Staff Calendar Sync", td_style),
            Paragraph("Configure verified Google OAuth client ID & secret.", td_style)
        ],
        [
            Paragraph("<b>Secret Exposure in Frontend Dir</b><br/>Service role key in frontend env", td_style),
            Paragraph("Server secrets pasted into <code>frontend/.env.local</code>.", td_style),
            Paragraph("P1", td_status_crit),
            Paragraph("Security & credential leakage", td_style),
            Paragraph("Purge all non-<code>NEXT_PUBLIC_*</code> variables from frontend folder.", td_style)
        ]
    ]
    t_crash = Table(crash_data, colWidths=[120, 110, 30, 110, 162])
    t_crash.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1e293b')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cbd5e1')),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#f8fafc'), colors.white]),
    ]))
    story.append(t_crash)
    story.append(Spacer(1, 10))

    # SECTION D: THIRD-PARTY INTEGRATION AUDIT
    story.append(Paragraph("D. Third-Party Integration Deep-Dive", h1_style))
    
    story.append(Paragraph("<b>1. PayU India (Decision 20, Migration 0035)</b>", h2_style))
    story.append(Paragraph(
        "• <b>Mechanism:</b> Auto-debit mandates (recurring SI) for subscriptions; one-time payments for top-ups (₹1,199).<br/>"
        "• <b>Security:</b> Inbound payment returns to <code>/api/billing/payu/return</code> are never trusted directly; "
        "the server executes a server-to-server <code>verifyPayment()</code> check signed with <code>PAYU_MERCHANT_SALT</code>.<br/>"
        "• <b>Status:</b> Ready in <code>test</code> mode. Switch to <code>PAYU_MODE=live</code> requires Raja's merchant KYC and SI activation.<br/>"
        "• <b>Launch Blocker:</b> YES (for paid conversions).",
        body_style
    ))

    story.append(Paragraph("<b>2. Meta WhatsApp Business Cloud API</b>", h2_style))
    story.append(Paragraph(
        "• <b>Mechanism:</b> Inbound webhooks received at <code>/api/webhooks/whatsapp</code>; outbound messages via Meta Graph v26.0.<br/>"
        "• <b>Security:</b> GET handshake verifies <code>META_WEBHOOK_VERIFY_TOKEN</code> with timing-safe SHA-256 compare. "
        "POST messages verify HMAC-SHA256 signature against <code>META_APP_SECRET</code>.<br/>"
        "• <b>Status:</b> Configured with shared demo number (WABA <code>2454480031626919</code>). Embedded Signup remains toggled off until Meta Tech Provider approval.<br/>"
        "• <b>Launch Blocker:</b> YES.",
        body_style
    ))

    story.append(Paragraph("<b>3. Inngest (Durable Jobs Engine)</b>", h2_style))
    story.append(Paragraph(
        "• <b>Mechanism:</b> Single endpoint at <code>/api/inngest</code> serving 28 functions (8 crons, 20 event workflows).<br/>"
        "• <b>Security:</b> In production, rejects un-signed requests with HTTP 401 using <code>INNGEST_SIGNING_KEY</code>.<br/>"
        "• <b>Status:</b> Working; requires explicit sync command (<code>curl -X PUT https://api.pakkaagent.in/api/inngest</code>) after deployment.<br/>"
        "• <b>Launch Blocker:</b> YES.",
        body_style
    ))

    story.append(Paragraph("<b>4. Supabase (PostgreSQL 17, Auth, Storage, Realtime)</b>", h2_style))
    story.append(Paragraph(
        "• <b>Database:</b> 51 migrations (<code>0001</code> to <code>0052</code>) cleanly applied. Strict RLS enforced across all tenant tables.<br/>"
        "• <b>Storage:</b> Media stored in private bucket <code>message-media</code> accessed via service-role client. No separate S3 credentials required.<br/>"
        "• <b>Status:</b> Staging operational on Mumbai (<code>ap-south-1</code>). Pro plan upgrade required to ensure automated daily backups and zero-pause.<br/>"
        "• <b>Launch Blocker:</b> YES.",
        body_style
    ))

    story.append(Paragraph("<b>5. Sentry & Langfuse (Observability)</b>", h2_style))
    story.append(Paragraph(
        "• <b>Sentry:</b> Direct envelope dispatcher (<code>report.ts</code>, no heavy SDK) with automated PII masking. Fails closed when unset.<br/>"
        "• <b>Langfuse:</b> Optional LLM tracing. <code>LANGFUSE_CAPTURE_TEXT</code> defaults to false to prevent customer text leakage.<br/>"
        "• <b>Launch Blocker:</b> NO (Observability enhancements).",
        body_style
    ))
    story.append(Spacer(1, 10))

    # SECTION E & F: ACTION ITEMS FOR DEV 2
    story.append(Paragraph("E. Action Items for Dev 2", h1_style))
    actions_data = [
        [Paragraph("<b>Category</b>", th_style), Paragraph("<b>Action Item</b>", th_style), Paragraph("<b>Target Location</b>", th_style), Paragraph("<b>Required Access</b>", th_style)],
        [Paragraph("Repository", td_style), Paragraph("Add <code>NEXT_PUBLIC_API_URL</code> to frontend env; purge service-role secrets from frontend folder.", td_style), Paragraph("<code>frontend/.env.local</code>", td_style), Paragraph("Local Repo", td_style)],
        [Paragraph("Railway", td_style), Paragraph("Set <code>API_PUBLIC_URL</code>, <code>ANTHROPIC_API_KEY</code>, and generate fresh 32-byte <code>ENCRYPTION_KEY</code>.", td_style), Paragraph("Railway Dashboard", td_style), Paragraph("Railway Production", td_style)],
        [Paragraph("Vercel", td_style), Paragraph("Set <code>NEXT_PUBLIC_API_URL</code>, Supabase URLs, and Meta App ID. Confirm no secrets exist.", td_style), Paragraph("Vercel Dashboard", td_style), Paragraph("Vercel Project", td_style)],
        [Paragraph("Supabase", td_style), Paragraph("Push migrations <code>0001-0052</code>; configure Auth Site URL to <code>https://app.pakkaagent.in</code>.", td_style), Paragraph("Supabase Console", td_style), Paragraph("Supabase Admin", td_style)],
        [Paragraph("Inngest", td_style), Paragraph("Execute <code>curl -X PUT https://api.pakkaagent.in/api/inngest</code> and confirm 28 functions registered.", td_style), Paragraph("Inngest Cloud", td_style), Paragraph("Inngest Org", td_style)],
        [Paragraph("Raja / PayU", td_style), Paragraph("Obtain live PayU Merchant Key & Salt; register webhook URL <code>/api/webhooks/payu</code>.", td_style), Paragraph("PayU Merchant Portal", td_style), Paragraph("Raja (Owner)", td_style)]
    ]
    t_actions = Table(actions_data, colWidths=[80, 242, 110, 100])
    t_actions.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1e293b')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cbd5e1')),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#f8fafc'), colors.white]),
    ]))
    story.append(t_actions)
    story.append(Spacer(1, 10))

    # SECTION G: PRIORITIZED EXECUTION PLAN
    story.append(Paragraph("F. Prioritized Execution Plan", h1_style))
    story.append(Paragraph(
        "<b>Phase 1: P0 (Boot Blockers — Fix Immediately)</b><br/>"
        "1. Populate <code>ANTHROPIC_API_KEY</code>, <code>EMBEDDINGS_API_KEY</code>, and <code>ENCRYPTION_KEY</code> in Railway.<br/>"
        "2. Add <code>NEXT_PUBLIC_API_URL</code> to Vercel and <code>API_PUBLIC_URL</code> to Railway.<br/>"
        "3. Verify Railway healthcheck answers HTTP 200 on <code>/api/health</code>.<br/><br/>"
        "<b>Phase 2: P1 (Pre-Launch Functional Verification)</b><br/>"
        "4. Apply full migration suite (<code>0001</code> to <code>0052</code>) on production Supabase.<br/>"
        "5. Re-sync Inngest production app and verify 28 functions show green.<br/>"
        "6. Test PayU test transaction drill (₹1,199 top-up) and verify credit grant.<br/>"
        "7. Complete Meta webhook challenge handshake on live domain.<br/><br/>"
        "<b>Phase 3: P2 (Operational Hardening)</b><br/>"
        "8. Configure Sentry DSN and verify alert thresholds.<br/>"
        "9. Execute weekly database backup dump drill to encrypted storage.<br/>"
        "10. Connect verified Google Cloud OAuth credentials for staff Google Calendar sync.",
        body_style
    ))
    
    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"PDF built successfully: {filename}")

if __name__ == "__main__":
    out_dir = r"d:\Pakkaagent\pakka-agent\docs"
    os.makedirs(out_dir, exist_ok=True)
    pdf_path = os.path.join(out_dir, "pakka-agent-production-audit.pdf")
    build_pdf(pdf_path)
