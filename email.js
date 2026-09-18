const sgMail = require('@sendgrid/mail');
const QRCode = require('qrcode');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
require('dotenv').config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// pdf-lib's built-in fonts can only draw Latin-1 characters. Anything else
// (Devanagari names, emoji, curly quotes from phones) used to throw, which
// silently stopped the ticket email from being sent at all.
function pdfSafe(value, fallback) {
    const out = String(value ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
        .trim();
    return out || fallback;
}

function wrapText(text, font, size, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
            line = candidate;
        } else {
            if (line) lines.push(line);
            line = word;
        }
    }
    if (line) lines.push(line);
    return lines;
}

const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);

async function createTicketPDF(booking) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // The QR code holds the raw ticket id; the scanner looks it up as-is.
    const qrCodeDataURL = await QRCode.toDataURL(String(booking.id), { margin: 1, width: 400 });
    const qrImageBytes = Buffer.from(qrCodeDataURL.split(',')[1], 'base64');
    const qrImage = await pdfDoc.embedPng(qrImageBytes);

    const ticketId = pdfSafe(booking.id, 'N/A');
    const eventName = pdfSafe(booking.event, 'Event');
    const name = pdfSafe(booking.primary_name, 'Guest');
    const when = pdfSafe([booking.date, booking.time].filter(Boolean).join(' | '), '');
    const where = pdfSafe(booking.location, '');

    // Text stays left of the QR code so long event names cannot run under it.
    const textWidth = width - 50 - 230;
    let y = height - 70;

    page.drawText('Event Ticket', { x: 50, y, font: boldFont, size: 36 });
    y -= 30;
    page.drawText('Sambhav Club', { x: 50, y, font, size: 18 });
    page.drawImage(qrImage, { x: width - 210, y: height - 230, width: 160, height: 160 });

    const section = (label, value, size) => {
        y -= 40;
        page.drawText(label, { x: 50, y, font: boldFont, size: 12, color: rgb(0.35, 0.35, 0.35) });
        for (const line of wrapText(value, font, size, textWidth)) {
            y -= size + 6;
            page.drawText(line, { x: 50, y, font, size });
        }
    };

    section('EVENT', eventName, 16);
    if (when) section('WHEN', when, 13);
    if (where) section('WHERE', where, 13);
    section('ATTENDEE', name, 14);
    section('TICKET ID', ticketId, 12);

    y -= 40;
    page.drawText('Show this QR code at the entrance. Each ticket admits one person per day.', {
        x: 50, y, font, size: 10, color: rgb(0.35, 0.35, 0.35),
    });

    return await pdfDoc.save();
}

async function sendTicketEmail(booking) {
    try {
        const ticketPdfBytes = await createTicketPDF(booking);
        const msg = {
            to: booking.email,
            from: process.env.VERIFIED_SENDER_EMAIL,
            subject: `Your Ticket for ${booking.event}`,
            html:
                `<p>Hi ${escapeHtml(booking.primary_name)},</p>` +
                `<p>Your ticket for <strong>${escapeHtml(booking.event)}</strong> is attached.</p>` +
                `<p>Ticket ID: <strong>${escapeHtml(booking.id)}</strong></p>` +
                `<p>Show the QR code in the attached PDF at the entrance.</p>`,
            attachments: [{
                content: Buffer.from(ticketPdfBytes).toString('base64'),
                filename: `ticket-${booking.id}.pdf`,
                type: 'application/pdf',
                disposition: 'attachment',
            }],
        };
        await sgMail.send(msg);
        console.log(`✅ Ticket emailed to ${booking.email}`);
    } catch (error) {
        console.error(`❌ Email failed:`, error);
        throw error;
    }
}

module.exports = { sendTicketEmail, createTicketPDF };
