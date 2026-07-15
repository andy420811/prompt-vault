/* Prompt Vault — 關鍵字字典與預設選項（離線分析器用）
   此檔為主程式 prompt-vault.html 的資料模組，必須在主程式 <script> 之前載入。
   （拆分自單檔以利維護；請與 index.html / prompt-vault.html 放在同一資料夾） */
const PRESETS = {
  camera: [["推進","dolly in"],["拉遠","dolly out"],["環繞","orbit shot"],["空拍","aerial drone shot"],
    ["手持","handheld"],["橫移","panning shot"],["俯拍","top-down shot"],["仰角","low angle shot"],
    ["跟拍","tracking shot"],["縮時","hyperlapse"],["升降鏡","crane shot"],["變焦推近","zoom in"],
    ["第一人稱","POV shot"],["穩定運鏡","smooth gimbal movement"]],
  style: [["電影感","cinematic"],["寫實照片","photorealistic"],["日系動漫","anime style"],["3D 渲染","3D render"],
    ["扁平插畫","flat vector illustration"],["水彩","watercolor"],["賽博龐克","cyberpunk"],["復古底片","vintage film"],
    ["極簡","minimalist"],["皮克斯風","Pixar style"],["吉卜力風","Studio Ghibli style"],["黑白","black and white"],
    ["油畫","oil painting"],["像素風","pixel art"],["蒸氣波","vaporwave"],["超現實","surreal"]],
  light: [["黃金時刻","golden hour"],["逆光","backlight"],["霓虹燈","neon lighting"],["柔光","soft lighting"],
    ["戲劇光影","dramatic lighting"],["棚燈","studio lighting"],["體積光","volumetric light"],["藍調時刻","blue hour"],
    ["高調","high-key lighting"],["低調","low-key lighting"],["邊緣光","rim light"],["自然光","natural light"]],
  shot: [["特寫","close-up"],["極特寫","extreme close-up"],["中景","medium shot"],["廣角全景","wide shot"],
    ["遠景","establishing shot"],["淺景深","shallow depth of field"],["對稱構圖","symmetrical composition"],
    ["三分法","rule of thirds"],["中央構圖","centered composition"],["微距","macro"],["魚眼","fisheye"],["鳥瞰","bird's-eye view"]]
};

// ---------- offline analyzer dictionaries ----------
const DETECT = {
  camera: {
    "dolly in":["dolly in","dolly-in","push in","push-in","move closer","推進","推近鏡頭"],
    "dolly out":["dolly out","dolly-out","pull back","pull-back","拉遠","後拉"],
    "orbit shot":["orbit","360 spin","360 orbit","rotate around","revolve around","circling","環繞","繞著","旋轉一圈"],
    "aerial drone shot":["aerial","drone","fly over","flyover","空拍","無人機","航拍"],
    "handheld":["handheld","hand-held","shaky cam","手持"],
    "panning shot":["panning","pan across","pan shot","橫移","平移","搖鏡"],
    "top-down shot":["top-down","top down","overhead shot","flat lay","flatlay","俯拍","俯視"],
    "low angle shot":["low angle","low-angle","worm's eye","仰角","仰拍","低角度"],
    "tracking shot":["tracking shot","follow shot","following shot","trailing shot","跟拍","跟隨鏡頭"],
    "hyperlapse":["hyperlapse","timelapse","time-lapse","time lapse","縮時","延時"],
    "crane shot":["crane shot","jib shot","boom shot","rising shot","升降鏡","上升鏡頭"],
    "zoom in":["zoom in","zoom-in","punch in","變焦推近","急推"],
    "POV shot":["pov ","point of view","first person","first-person","第一人稱","主觀視角"],
    "smooth gimbal movement":["gimbal","steadicam","stabilized","smooth camera","穩定器","絲滑運鏡"]
  },
  style: {
    "cinematic":["cinematic","film still","movie still","filmic","電影感","電影質感"],
    "photorealistic":["photorealistic","photo-realistic","photoreal","hyperrealistic","realistic photo","dslr","raw photo","寫實","擬真","真實照片"],
    "anime style":["anime","manga","動漫","二次元","日漫"],
    "3D render":["3d render","3d-render","octane","unreal engine","blender render","cgi","c4d","3d渲染","三維"],
    "flat vector illustration":["flat vector","vector illustration","flat illustration","flat design","扁平插畫","向量插畫","扁平風"],
    "watercolor":["watercolor","watercolour","水彩"],
    "cyberpunk":["cyberpunk","neon noir","賽博龐克","賽博朋克"],
    "vintage film":["vintage","retro film","film grain","analog film","kodak","polaroid","復古","底片感","膠片"],
    "minimalist":["minimalist","minimalistic","clean design","極簡","簡約","乾淨","設計感"],
    "Pixar style":["pixar","皮克斯"],
    "Studio Ghibli style":["ghibli","miyazaki","吉卜力","宮崎駿"],
    "black and white":["black and white","b&w","monochrome","grayscale","greyscale","黑白","單色"],
    "oil painting":["oil painting","oil on canvas","油畫"],
    "pixel art":["pixel art","8-bit","16-bit","pixelated","像素風","像素藝術"],
    "vaporwave":["vaporwave","synthwave","蒸氣波","蒸汽波"],
    "surreal":["surreal","dreamlike","dali","超現實","夢境感"]
  },
  light: {
    "golden hour":["golden hour","sunset light","warm sunlight","黃金時刻","夕陽","日落光"],
    "backlight":["backlight","backlit","back-lit","逆光","背光"],
    "neon lighting":["neon","霓虹"],
    "soft lighting":["soft light","soft lighting","diffused light","柔光","柔和光"],
    "dramatic lighting":["dramatic light","chiaroscuro","moody light","戲劇光","戲劇性光影"],
    "studio lighting":["studio light","softbox","studio lighting","棚燈","攝影棚燈","柔光箱"],
    "volumetric light":["volumetric","god rays","light rays","體積光","耶穌光","丁達爾"],
    "blue hour":["blue hour","twilight","dusk","藍調時刻","暮色","黃昏"],
    "high-key lighting":["high-key","high key","高調光"],
    "low-key lighting":["low-key","low key","低調光","暗調"],
    "rim light":["rim light","rim lighting","edge light","邊緣光","輪廓光"],
    "natural light":["natural light","daylight","ambient light","自然光","日光","窗光"]
  },
  shot: {
    "close-up":["close-up","close up","closeup","特寫"],
    "extreme close-up":["extreme close","大特寫","極特寫"],
    "medium shot":["medium shot","waist up","half body","中景","半身"],
    "wide shot":["wide shot","wide angle","wide-angle","廣角","全景"],
    "establishing shot":["establishing shot","vista","遠景","大遠景"],
    "shallow depth of field":["shallow depth","shallow dof","bokeh","depth of field","淺景深","散景","景深"],
    "symmetrical composition":["symmetrical","symmetry","對稱"],
    "rule of thirds":["rule of thirds","三分法"],
    "centered composition":["centered composition","central composition","置中","居中構圖"],
    "macro":["macro","微距"],
    "fisheye":["fisheye","fish-eye","魚眼"],
    "bird's-eye view":["bird's eye","birds eye","aerial view","top view","鳥瞰","俯瞰"]
  }
};
const MOTION = new Set(["dolly in","dolly out","orbit shot","tracking shot","hyperlapse","crane shot","zoom in","panning shot","smooth gimbal movement"]);
const VIDEO_WORDS = ["fps"," second","seconds","loop","in motion","slow motion","slow-motion","hyperlapse","timelapse","time-lapse","cinemagraph"," footage","b-roll","broll","運鏡","慢動作","動態影片","影片素材","短片","秒的影片","動起來"];
const IMG_FORCE = ["封面","縮圖","海報","thumbnail","poster","一張圖","圖片","照片"];
const MODELS = [["midjourney","Midjourney"],["niji","Midjourney"],["flux","Flux"],["stable diffusion","Stable Diffusion"],
  ["sdxl","Stable Diffusion"],["dall-e","DALL·E 3"],["dall·e","DALL·E 3"],["dalle","DALL·E 3"],["nano banana","Nano Banana"],
  ["ideogram","Ideogram"],["sora","Sora"],["runway","Runway Gen-3"],["gen-3","Runway Gen-3"],["gen-2","Runway Gen-3"],
  ["kling","Kling"],["veo","Veo"],["hailuo","Hailuo"],["minimax","Hailuo"],["pika","Pika"],["luma","Luma"],["dream machine","Luma"]];
const SUBJECT_TAGS = [
  [["thumbnail","封面","縮圖"],"縮圖"],
  [["portrait","headshot","person ","creator","selfie","people","character","人物","人像","女孩","男生"],"人物"],
  [["product","gadget","packaging","cosmetic","bottle","產品","開箱"],"產品"],
  [["cityscape","city ","street","urban","skyline","城市","街景"],"城市"],
  [["landscape","mountain","forest","nature","ocean","beach","風景","山","森林","海"],"風景"],
  [["food","dish ","cuisine","coffee","drink","美食","食物","料理","咖啡"],"美食"],
  [["logo","emblem","brand icon"],"LOGO"],
  [["studio desk","interior","bedroom","office","kitchen","場景","房間","室內"],"場景"],
  [["b-roll","broll"],"B-roll"],
  [["intro","opening scene","title card","開場","片頭"],"開場"],
  [["sports car","vehicle","motorcycle","車輛","跑車","機車"],"車輛"],
  [["cheerleader","啦啦隊"],"啦啦隊"],
  [["baseball","棒球","開球","中職","cpbl"],"棒球"],
  [["富邦","fubon angles","fubon angels"],"富邦Angels"],
  [["台鋼","wingstars","takao"],"台鋼雄鷹"],
  [["樂天","rakuten girls"],"樂天桃猿"],
  [["統一","uni girls","uni-girls"],"統一獅"],
  [["中信兄弟","passion sisters"],"中信兄弟"],
  [["模板","template"],"模板改版"]
];
