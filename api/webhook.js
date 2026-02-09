import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. Setup Supabase
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 2. Setup Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 3. Helper: Send WhatsApp Message
async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  console.log(`📤 Sending Reply to ${to}: ${body}`);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: body },
      }),
    });
    const data = await response.json();
    if (data.error) {
      console.error('❌ WhatsApp Send Error:', JSON.stringify(data.error));
    } else {
      console.log('✅ Message Sent!');
    }
  } catch (err) {
    console.error('❌ Network Error Sending Message:', err);
  }
}

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  try {
    console.log(`🔹 Method: ${req.method}`);

    // A. VERIFICATION
    if (req.method === 'GET') {
      if (
        req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN
      ) {
        return res.status(200).send(req.query['hub.challenge']);
      }
      return res.status(403).json({ error: 'Verification failed' });
    }

    // B. INCOMING MESSAGES
    if (req.method === 'POST') {
      const body = req.body;
      
      // LOG RAW INPUT for debugging
      console.log("📥 Incoming Webhook Body:", JSON.stringify(body, null, 2));

      if (body.object === 'whatsapp_business_account') {
        const changes = body.entry?.[0]?.changes?.[0]?.value;
        const message = changes?.messages?.[0];

        if (!message) {
            console.log("⚠️ No message found in body.");
            return res.status(200).send('No message');
        }

        const senderPhone = message.from; 
        const messageType = message.type;
        console.log(`📱 From: ${senderPhone}, Type: ${messageType}`);

        // 1. IDENTIFY USER
        const { data: user, error } = await supabase
          .from('users')
          .select('*, tenants(subscription_status)')
          .eq('phone_number', senderPhone)
          .single();

        if (error || !user) {
          console.log(`🚫 User lookup failed for ${senderPhone}. Error:`, error);
          // Don't reply to avoid spam loops
        } 
        else {
            console.log(`✅ User Found: ${user.name} (${user.id})`);
            
            const status = user.tenants?.subscription_status;
            const userName = user.name || "Staff";

            if (status !== 'active') {
                console.log("🛑 Account Inactive");
                await sendWhatsAppMessage(senderPhone, `Hi ${userName}, account Inactive.`);
            } else {
                
                // 2. TEXT HANDLER
                if (messageType === 'text') {
                    await sendWhatsAppMessage(senderPhone, `👋 Hi ${userName}! Send me a receipt photo.`);
                } 
                
                // 3. MEDIA HANDLER
                else if (messageType === 'image' || messageType === 'document') {
                    
                    // --- HACKATHON GUARD: REJECT PDFS TO PREVENT CRASH ---
                    if (messageType === 'document') {
                        await sendWhatsAppMessage(senderPhone, `⚠️ Hackathon Demo: Please send an **Image (JPG/PNG)** of the document. Processing PDFs takes too long for the live demo!`);
                        return res.status(200).send('PDF Skipped');
                    }
                    
                    // --- PROCEED ONLY IF IMAGE ---
                    const mediaId = message.image.id;
                    const mimeType = message.image.mime_type || 'image/jpeg';
                    const extension = 'jpg';

                    console.log(`📂 Processing Image: ${mediaId} (${mimeType})`);
                    await sendWhatsAppMessage(senderPhone, `🤖 Reading your receipt...`);

                    try {
                        // A. Get Media URL
                        const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
                            headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` }
                        });
                        const mediaData = await mediaRes.json();
                        
                        if (!mediaData.url) {
                            console.error("❌ Meta Media API Error:", mediaData);
                            throw new Error("Could not get Media URL from Meta");
                        }
                        const mediaUrl = mediaData.url;
                        console.log("🔗 Media URL Retrieved");

                        // B. Download Binary
                        const imageRes = await fetch(mediaUrl, {
                            headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` }
                        });
                        const arrayBuffer = await imageRes.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);
                        console.log(`💾 Downloaded ${buffer.length} bytes`);

                        // C. Upload to Supabase
                        const filename = `${user.tenant_id}/${Date.now()}.${extension}`;
                        const { error: uploadError } = await supabase.storage
                            .from('receipts')
                            .upload(filename, buffer, { contentType: mimeType });

                        if (uploadError) {
                            console.error("❌ Storage Upload Error:", uploadError);
                            throw uploadError;
                        }
                        const { data: { publicUrl } } = supabase.storage.from('receipts').getPublicUrl(filename);
                        console.log("☁️ Uploaded to Storage:", publicUrl);

                        // D. Send to Gemini
                        console.log("🧠 Sending to Gemini 2.5 Flash...");
                        const finalModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                        
                        const prompt = `You are an expert AI Data Extractor for accounting. 
                        Extract ALL data from this image/PDF (which could be a Receipt, Tax Invoice, Purchase Order or Banks Statements).
                        
                        Return a single JSON object with these specific requirements:

                        1. STANDARD FIELDS (Use these exact keys for the UI):
                           - "merchant_name": (string) Name of the vendor/seller.
                           - "total_amount": (number) The final grand total.
                           - "date": (string) YYYY-MM-DD.
                           - "category": (string) Infer category (e.g., 'Travel', 'Inventory', 'Utilities').
                           - "doc_type": (string) e.g., 'Invoice', 'Receipt', 'PO'.

                        2. COMPREHENSIVE EXTRACTION (For "AI Details"):
                           - Extract EVERY other visible field as a key-value pair.
                           - Look specifically for: "invoice_number", "po_number", "gstin_supplier", "gstin_buyer", "base_amount", "tax_amount" (IGST/CGST/SGST), "line_items" (as an array if possible).
                           - If you see an address, extract it.`;
                        
                        const result = await finalModel.generateContent([
                            prompt, 
                            { inlineData: { data: buffer.toString('base64'), mimeType: mimeType } }
                        ]);
                        
                        const text = result.response.text().replace(/```json|```/g, '').trim();
                        console.log("🧠 Gemini Response:", text);

                        let extractedData;
                        try {
                           extractedData = JSON.parse(text);
                        } catch (e) {
                           console.error("⚠️ JSON Parse Failed. Raw text:", text);
                           extractedData = { merchant_name: "Unreadable", total_amount: 0 };
                        }

                        // E. Save to DB (FIXED VARIABLE NAMES)
                        const { error: dbInsertError } = await supabase.from('transactions').insert({
                            tenant_id: user.tenant_id,
                            user_id: user.id,
                            // FIX: Using 'total_amount' from JSON, mapping to 'amount' in DB
                            amount: extractedData.total_amount || 0,
                            // FIX: Using 'merchant_name' from JSON, mapping to 'merchant' in DB
                            merchant: extractedData.merchant_name || 'Unknown',
                            status: 'Pending',
                            image_url: publicUrl,
                            metadata: extractedData,
                            category: extractedData.category
                        });
                        
                        if(dbInsertError) console.error("❌ DB Insert Error:", dbInsertError);

                        // FIX: Using correct variables in the Reply
                        await sendWhatsAppMessage(senderPhone, `✅ Saved!\n\n🏪 ${extractedData.merchant_name || 'Unknown'}\n💰 ₹${extractedData.total_amount || 0}`);

                    } catch (err) {
                        console.error("❌ Processing Logic Error:", err);
                        await sendWhatsAppMessage(senderPhone, "❌ Error reading file. Please try again.");
                    }
                }
            }
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.status(405).send('Method Not Allowed');

  } catch (fatalError) {
    console.error("🔥 FATAL CRASH:", fatalError);
    return res.status(500).send("Internal Server Error");
  }
}
