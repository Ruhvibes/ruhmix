# RuhMix AI Server — Deploy Guide (Roman Hindi)

**Hasnain, ye guide step-by-step hai. Laptop/PC chahiye (ek baar ka kaam, 20-30 min).**

---

## 1. Ye server kya hai?

RuhMix app me **"AI Stem Separation"** dabane par gaana phone se is server par jata hai. Server (Modal ka T4 GPU) Meta ke **Demucs** AI model se gaane ko **4 hisson** me todta hai — **Vocals, Drums, Bass, Other** — aur wapas bhej deta hai. Phir app inhe mixer me load karti hai.

**Kharcha: ₹0.** Modal har mahine **$30 free credits** deta hai (recurring). T4 GPU par ye **sainkadon gaane/month** ke liye kaafi hai. Is code me koi paid cheez ON nahi hai.

---

## 2. ⚠️ IMAANDAAR NOTE — card ke baare me (zaroor padho)

**Card lagana MANDATORY hai.** Modal ke official rules ke hisaab se bina payment method (card) ke account kaam nahi karega. Ye unka rule hai — isse bacha nahi ja sakta.

**Lekin paise NAHI katega — agar tum ye 1 setting kar do:**

Modal me **"Spend Limit"** naam ki setting hai. Ise **$0** par set karne se:
- Free $30 credits ke andar sab chalta rahega (tumhara use isme aaram se aayega)
- Credits khatm hone par Modal **server rok dega** — card se **ek rupaya bhi auto-charge NAHI hoga**

⚠️ **Bina Spend Limit lagaye deploy MAT karna** — warna $30 khatm hote hi card se auto-charge shuru ho jayega (ye Modal ka default behavior hai).

**Ek aur baat:** card par **international transactions ON** hone chahiye (bank app me toggle milta hai — RBI rule se naye cards par by default OFF hota hai). Spend Limit $0 ke baad charge hoga hi nahi, lekin signup ke liye card verify hona chahiye.

---

## 3. Deploy steps (laptop/PC se)

### Step 1 — Modal account banao
1. **modal.com** kholo → **Sign Up** (GitHub ya Google se login ho jata hai)
2. Login ke baad **Billing / Payment method** me apna card add karo (international transactions ON rakho)
3. **Settings → Spend Limit** (ya Billing → Budgets) me jao → **Spend Limit = $0** set karo → Save
   - ✅ Ab card se kabhi paise nahi katega. Ye sabse zaroori step hai.

### Step 2 — Modal CLI install karo
Laptop/PC par terminal me:
```
pip install modal
modal setup
```
`modal setup` browser me ek page kholega — wahan **Allow** dabao, token ban jayega.

### Step 3 — API key ka secret banao
Ye key tumhare server ka "password" hai — taaki koi anjaan tumhara free GPU quota na jala sake:
```
modal secret create ruhmix-ai-key API_KEY=tumhari-lambi-random-key-yahan
```
Key khud banao — lambi random, jaise: `API_KEY=rmx-9f3k2jd84hfjs73hf92x7qpw41zm`
**Is key ko apne phone ke notes me likh lo — app me daalni padegi (Step 5).**

### Step 4 — Deploy karo
Isi folder (`ruhmix-ai-server`) me terminal kholo:
```
modal deploy ruhmix_stems.py
```
2-4 minute lagega. Aakhir me ek URL milega, jaise:
```
https://hasnain--ruhmix-stems-web.modal.run
```
**Ye URL copy kar lo — yehi tumhara server hai.**

> Pehli request par AI model download hoga (~2.5 GB, 5-10 min). Uske baad har gaana 1-3 min me process hoga. Model ek baar download hokar Modal ke storage me save rehta hai — dobara download nahi hota.

### Step 5 — App me URL + key daalo
1. Phone me **RuhMix** kholo → **Settings** → **🤖 AI Server**
2. **Modal Endpoint URL** me wo URL paste karo (Step 4 wala)
3. **API Key** me wo key paste karo (Step 3 wali)
4. **💾 सहेजें** → phir **🔌 कनेक्शन जांचें** dabao
5. ✅ **"सर्वर ठीक है"** dikhe to taiyaar! (Pehli baar GPU start hone me 30-60 second lag sakta hai — ghabrana mat)

### Step 6 — Pehla gaana try karo
1. Koi gaana import karo → **AI Stem Separation** kholo
2. Consent padho → **सहमत**
3. Ek chhota **ad** dekho (30 sec) — **1 ad = 1 gaana** (yehi ad server ka kharcha uthata hai)
4. Upload → AI process (1-3 min) → **4 stems** mixer me! 🎉

---

## 4. Server band/expired ho to app me kya dikhega?

| Situation | App me kya dikhega |
|---|---|
| URL/key galat | "API Key galat hai ya authorized nahi. Settings me key check karein." + Retry |
| Server so raha hai (pehli request) | 30-60s wait, phir kaam karega (GPU cold start) |
| Free credits khatm (Spend Limit $0) | "Server se connect nahi ho pa raha" + Retry + **Beta (DSP)** fallback button |
| Internet nahi | "Server se connect nahi ho pa raha. Internet check karein." |

**Server band ho to gaana nahi rukega:** har error screen par **"Bina server ke basic separation (Beta DSP)"** ka button hai — wo on-device hai, neural AI nahi, lekin kaam karta hai.

**Modal dashboard** (modal.com → tumhara app) me dikhta hai: kitne credits bache, kitne gaane process huye.

---

## 5. Kharcha summary (imaandaar hisaab)

| Cheez | Kharcha |
|---|---|
| Modal free credits | **$30/month, har mahine naya** |
| T4 GPU | ~$0.59/ghanta → **~45-50 ghante/month free** |
| 1 gaana (3-4 min) | ~1-2 min GPU = **~₹1-2** |
| Tumhara kharcha | **₹0** (Spend Limit $0 ke saath) |
| 1 rewarded ad ki earning (tumko) | ~₹5-15 |

**Matlab:** ek ad (~₹5-15) me 3-7 gaanon ka server kharcha nikal aata hai. Ye **self-funding loop** hai — jitne ad, utne gaane free me process. Isiliye AI Separation se pehle ad zaroori hai.

---

## 6. Technical notes (developer ke liye)

- File: `ruhmix_stems.py` — single Modal app, `@modal.asgi_app()` (FastAPI)
- Endpoints: `GET /health`, `POST /separate` (multipart `file` → ZIP of 4 WAVs, stored/uncompressed)
- GPU: T4, timeout 30 min, scale-to-zero (idle pe ₹0)
- Model: `htdemucs`, weights Modal Volume `ruhmix-models` me cache
- Auth: `X-API-Key` header, Modal secret `ruhmix-ai-key` se (REQUIRED — secret bina deploy fail hoga, taaki quota safe rahe)
- Privacy: har request ke temp files turant delete (koi retention nahi)
- Purana Docker/FastAPI server (`app.py`, `Dockerfile`) isi folder me **fallback** ke roop me rakha hai — zaroorat pade to kaam aayega
