/* Prompt Vault — 首次開啟顯示的示範資料
   此檔為主程式 prompt-vault.html 的資料模組，必須在主程式 <script> 之前載入。
   （拆分自單檔以利維護；請與 index.html / prompt-vault.html 放在同一資料夾） */
const SEED = [
  { type:"image", title:"YouTube 縮圖主視覺・科幻臉部特寫",
    prompt:"cinematic close-up portrait of a young creator, dramatic rim lighting, teal and orange color grade, shocked expression, futuristic neon city bokeh background, ultra sharp, 8k",
    neg:"blurry, low contrast, watermark, text, extra fingers", model:"Midjourney",
    tags:["縮圖","人物"], params:{ar:"16:9",stylize:"400"},
    camera:[], style:["cinematic"], light:["rim light","dramatic lighting"], shot:["close-up","shallow depth of field"],
    notes:"臉部佔畫面 1/3，留右側放標題", url:"", img:"", fav:true,
    variants:[{id:"v_seed1",label:"暖色版",prompt:"cinematic close-up portrait of a young creator, warm golden hour light, amber tones, hopeful expression, cozy studio bokeh, ultra sharp, 8k",note:"改暖色調、換情緒"}] },
  { type:"image", title:"頻道開場・扁平插畫背景",
    prompt:"flat vector illustration, cozy home studio desk with microphone, warm morning light, muted pastel palette, minimal shapes, clean negative space on the left",
    neg:"3d, photorealistic, cluttered", model:"Flux",
    tags:["背景","開場"], params:{ar:"16:9"},
    camera:[], style:["flat vector illustration","minimalist"], light:["natural light"], shot:["centered composition"],
    notes:"", url:"", img:"", fav:false, variants:[] },
  { type:"video", title:"B-roll・城市縮時空拍",
    prompt:"aerial drone hyperlapse over a neon-lit city at dusk, smooth forward motion, traffic light trails, volumetric fog, cinematic teal-orange grade",
    neg:"shaky, jitter, warped buildings", model:"Runway Gen-3",
    tags:["B-roll","空拍"], params:{ar:"16:9",duration:"5",fps:"24"},
    camera:["aerial drone shot","hyperlapse"], style:["cinematic"], light:["neon lighting","volumetric light"], shot:["wide shot"],
    notes:"接開場後 2 秒，配 whoosh 音效", url:"", img:"", fav:true, variants:[] },
  { type:"video", title:"產品特寫・旋轉展示",
    prompt:"slow 360 orbit around a sleek gadget on a reflective black surface, soft studio softbox lighting, subtle lens flare, macro detail, shallow depth of field",
    neg:"fast motion, background clutter, blown highlights", model:"Kling",
    tags:["產品"], params:{ar:"16:9",duration:"6",fps:"30"},
    camera:["orbit shot","smooth gimbal movement"], style:["photorealistic"], light:["studio lighting"], shot:["macro","shallow depth of field"],
    notes:"", url:"", img:"", fav:false, variants:[] }
];
