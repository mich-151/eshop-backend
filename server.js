const express = require('express');
const cors = require('cors');

// Načítanie kľúčov z prostredia Renderu
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// E-mail na Zoznam.sk načítaný z premenných prostredia (s zálohou, ak by nebol nastavený)
const ADMIN_EMAIL = process.env.ZOZNAM_EMAIL || 'unicitysodovkaren@zoznam.sk';

/**
 * Hlavná funkcia pre odosielanie e-mailov cez Brevo HTTP API (Port 443 - HTTPS)
 * Vhodné pre Render.com, pretože neblokuje žiadne SMTP porty.
 */
async function sendEmailViaBrevo(toEmail, subject, textContent) {
  // Automatický prevod odriadkovania na HTML <br> pre pekné zobrazenie
  const htmlBody = textContent.replace(/\n/g, '<br>');

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY, // Získate v Brevo: SMTP & API -> API Keys
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: { 
        name: 'UNI-CITY Sodovkáreň', 
        email: 'sodovky@eshop-uni-city.sk'
      },
      to: [{ email: toEmail }],
      subject: subject,
      htmlContent: htmlBody
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Brevo API Error: ${JSON.stringify(errorData)}`);
  }

  return await response.json();
}

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// --------------------------------------------------------------------------
// TESTOVACÍ ENDPOINT - vyskúšaj v prehliadači: https://eshop-backend-fxq4.onrender.com/test-email
// --------------------------------------------------------------------------
app.get('/test-email', async (req, res) => {
  try {
    await sendEmailViaBrevo(
      ADMIN_EMAIL, 
      'Test z Renderu cez Brevo API', 
      'Pokiaľ toto čítaš, e-maily cez Brevo API fungujú skvele!'
    );
    res.send("🎉 E-mail bol ÚSPĚŠNĚ odoslaný na " + ADMIN_EMAIL + " cez Brevo API!");
  } catch (err) {
    res.status(500).send("❌ CHYBA: " + err.message + "<br><br><pre>" + err.stack + "</pre>");
  }
});

// Testovacia úvodná adresa
app.get('/', (req, res) => {
  res.send('Backend pre e-shop beží úspešne na Render.com!');
});

// --------------------------------------------------------------------------
// 1. Endpoint pre pokladňu a vytvorenie Stripe platby
// --------------------------------------------------------------------------
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customerInfo, deliveryInfo, shippingCost } = req.body;

    // --- BEZPEČNOSTNÁ KONTROLA LIMITU NAD 27 KUSOV ---
    const totalItemsCount = items.reduce((sum, item) => sum + item.quantity, 0);
    if (totalItemsCount > 27) {
      return res.status(400).json({ 
        error: 'Objednávky nad 27 ks riešime individuálne kvôli doprave. Prosím kontaktujte nás na sodovky@eshop-uni-city.sk' 
      });
    }
    // -------------------------------------------------

    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: { name: item.name },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.quantity,
    }));

    if (shippingCost > 0) {
      let shippingBezDPH = 0;
      let shippingDPH = 0;
      
      if (shippingCost === 3.90) { shippingBezDPH = 3.17; shippingDPH = 0.73; }
      else if (shippingCost === 5.90) { shippingBezDPH = 4.80; shippingDPH = 1.10; }
      else if (shippingCost === 5.99) { shippingBezDPH = 4.87; shippingDPH = 1.12; }
      else if (shippingCost === 7.49) { shippingBezDPH = 6.09; shippingDPH = 1.40; }
      else {
        shippingBezDPH = parseFloat((shippingCost / 1.23).toFixed(2));
        shippingDPH = parseFloat((shippingCost - shippingBezDPH).toFixed(2));
      }

      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { 
            name: 'Doprava a balné',
            description: `${deliveryInfo.details} (Bez DPH: ${shippingBezDPH.toFixed(2)} EUR, DPH 23%: ${shippingDPH.toFixed(2)} EUR)`
          },
          unit_amount: Math.round(shippingCost * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `https://eshop-backend-fxq4.onrender.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: 'https://eshop-uni-city.sk/',
      metadata: {
        customer_name: customerInfo.name,
        customer_email: customerInfo.email,
        customer_phone: customerInfo.phone,
        delivery_details: deliveryInfo.details
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------------------------------
// 2. Stránka PO ZAPLATENÍ -> Odoslanie e-mailov
// --------------------------------------------------------------------------
app.get('/success', async (req, res) => {
  const sessionId = req.query.session_id;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      const meta = session.metadata;
      
      // Načítanie VŠETKÝCH položiek z objednávky (až do limitu 100)
      const lineItemsList = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });

      let seznamZbozi = "";
      let castkaDopravy = "0.00";

      // Roztriedenie tovaru a dopravy
      lineItemsList.data.forEach(item => {
        const cenaPolozky = (item.amount_total / 100).toFixed(2);
        
        if (item.description.includes('Doprava a balné')) {
          castkaDopravy = cenaPolozky;
        } else {
          seznamZbozi += `- ${item.quantity}x ${item.description} (${cenaPolozky} EUR)\n`;
        }
      });
      
      const celkemSDPH = (session.amount_total / 100).toFixed(2);
      const celkemBezDPH = (celkemSDPH / 1.23).toFixed(2);
      const samotneDPH = (celkemSDPH - celkemBezDPH).toFixed(2);

      // Text pre zákazníka
      const zakaznikText = `Vážený zákazník ${meta.customer_name},\n\n` +
        `ďakujeme za Vašu objednávku a platbu.\n\n` +
        `Zhrnutie objednávky:\n` +
        `${seznamZbozi}` +
        `Doprava a balné: ${castkaDopravy} EUR\n` +
        `-----------------------------------------\n` +
        `Cena bez DPH: ${celkemBezDPH} EUR\n` +
        `DPH (23%): ${samotneDPH} EUR\n` +
        `Celkom zaplatené (s DPH): ${celkemSDPH} EUR\n\n` +
        `Miesto doručenia: ${meta.delivery_details}\n\n` +
        `Pekný deň!\n\n` +
        `UNI-CITY SERVICE spol. s r.o.\n` +
        `Podzávoz 3371\n` +
        `022 01 Čadca\n` +
        `Slovenská republika\n` +
        `tel.: 00421 905 533 947\n` +
        `Email: sodovky@eshop-uni-city.sk`;

      // Text pre sklad
      const skladText = `Ahojte tím,\nMáme novú uhradenú objednávku. Prosím zabaľte a odošlite následujúci tovar:\n\n` +
        `TOVAR K ZABALENIE:\n${seznamZbozi}\n` +
        `-----------------------------------------\n` +
        `ČIASTKA ZA DOPRAVU: ${castkaDopravy} EUR\n` +
        `CELKOVÁ ZAPLATENÁ SUMA: ${celkemSDPH} EUR\n` +
        `-----------------------------------------\n` +
        `DORUČOVACIE ÚDAJE:\n` +
        `Meno: ${meta.customer_name}\n` +
        `Telefón: ${meta.customer_phone}\n` +
        `E-mail: ${meta.customer_email}\n` +
        `Doručiť na: ${meta.delivery_details}\n`;

      // Odoslanie e-mailov cez Brevo API
      await Promise.all([
        sendEmailViaBrevo(meta.customer_email, 'Potvrdenie objednávky - Uni-City', zakaznikText),
        sendEmailViaBrevo(ADMIN_EMAIL, `NOVÝ TOVAR NA ZABALENIE - ${meta.customer_name}`, skladText)
      ]);

      res.redirect('https://eshop-uni-city.sk/'); 
    } else {
      res.send("Platba nebola dokončená.");
    }
  } catch (error) {
    console.error("Chyba pri odosielaní e-mailu z /success:", error);
    res.status(500).send("Chyba pri spracovaní objednávky: " + error.message);
  }
});

// --------------------------------------------------------------------------
// 3. Endpoint pre formulár odstúpenia od zmluvy
// --------------------------------------------------------------------------
app.post('/submit-withdrawal', async (req, res) => {
  try {
    const { orderNumber, orderDate, deliveryDate, name, email, address, phone, goods, iban } = req.body;

    const adminText = `Ahoj,\n\nNa e-shope bol vyplnený online formulár na odstúpenie od zmluvy do 14 dní.\n\n` +
      `ÚDAJE O OBJEDNÁVKE:\n` +
      `-----------------------------------------\n` +
      `Číslo objednávky/faktúry: ${orderNumber}\n` +
      `Dátum objednania: ${orderDate}\n` +
      `Dátum prevzatia tovaru: ${deliveryDate}\n\n` +
      `ÚDAJE O ZÁKAZNÍKOVI:\n` +
      `-----------------------------------------\n` +
      `Meno a priezvisko: ${name}\n` +
      `E-mail: ${email}\n` +
      `Adresa: ${address}\n` +
      `Telefón: ${phone}\n\n` +
      `VRÁTENÝ TOVAR:\n` +
      `-----------------------------------------\n` +
      `${goods}\n\n` +
      `FINANČNÉ VYSPORIADANIE:\n` +
      `-----------------------------------------\n` +
      `Číslo účtu (IBAN): ${iban}\n\n` +
      `Skontroluj prichádzajúci balík a po overení stavu tovaru poukáž platbu späť na účet zákazníka do 14 dní.`;

    const customerText = `Vážený zákazník, Vážená zákazníčka,\n\n` +
      `týmto Vám potvrdzujeme prijatie Vašej online žiadosti o odstúpenie od kúpnej zmluvy v zákonnej lehote k objednávke/faktúre č. ${orderNumber}.\n\n` +
      `Vaša žiadosť bola úspešne zaregistrovaná a momentálne ju spracovávame.\n\n` +
      `DÔLEŽITÉ INFORMÁCIE K ĎALŠIEMU POSTUPU:\n` +
      `1. Tovar je potrebné zaslať späť na našu adresu najneskôr do 14 dní odo dňa odoslania žiadosti.\n` +
      `2. Tovar posielajte na adresu sídla našej spoločnosti:\n` +
      `   UNI-CITY SERVICE spol. s r.o.\n` +
      `   Podzávoz 3371\n` +
      `   022 01 Čadca\n` +
      `3. Tovar zabaľte bezpečne, aby nedošlo k jeho poškodeniu počas prepravy. Náklady na vrátenie tovaru znáša kupujúci.\n\n` +
      `Po prijatí zásielky a kontrole vráteného tovaru Vám finančné prostriedky zašleme späť na Vami uvedený bankový účet (IBAN: ${iban}) v čo najkratšom čase, najneskôr do 14 dní od vrátenia tovaru.\n\n` +
      `V prípade akýchkoľvek otázok nás neváhajte kontaktovať odpoveďou na tento e-mail.\n\n` +
      `Ďakujeme za porozumenie.\n\n` +
      `S pozdravom,\n` +
      `Tím UNI-CITY SERVICE spol. s r.o.\n` +
      `Čadca - Podzávoz č. 3371\n022 01 Čadca\n` +
      `+421 905 533 947\n` +
      `sodovky@eshop-uni-city.sk\n` +
      `www.uni-city.sk`;

    await Promise.all([
      sendEmailViaBrevo(ADMIN_EMAIL, `⚠️ ODSTÚPENIE OD ZMLUVY - Obj. č. ${orderNumber} (${name})`, adminText),
      sendEmailViaBrevo(email, `Potvrdenie o prijatí odstúpenia od zmluvy - Obj. č. ${orderNumber}`, customerText)
    ]);

    console.log(`[Odstúpenie] E-maily k objednávke ${orderNumber} boli úspešne odoslané.`);
    res.status(200).json({ success: true, message: "Emails sent successfully" });

  } catch (error) {
    console.error("Chyba pri odosielaní e-mailu z /submit-withdrawal:", error);
    res.status(500).send("Chyba pri spracovaní objednávky: " + error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server beží na porte ${PORT}`));
