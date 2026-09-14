// 蕾米埃尔 Q版形象（SVG 代码绘制）
// 设计要素：粉色头发 / 压低帽檐的檐帽 / 羽希人小翅膀 / 粉-苍白-暮紫配色
// 换皮或调整形象只改这个文件
(function () {
  const SVG = `
<svg id="chara" viewBox="0 0 220 270" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="hairGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f7b3cd"/>
      <stop offset="1" stop-color="#ef97ba"/>
    </linearGradient>
    <linearGradient id="dressGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6f3f9"/>
      <stop offset="1" stop-color="#e9e2f0"/>
    </linearGradient>
  </defs>

  <!-- 地面阴影 -->
  <ellipse id="shadow" cx="110" cy="258" rx="50" ry="8" fill="rgba(45,25,60,0.22)"/>

  <g class="pose">
    <!-- 翅羽（羽希人） -->
    <g class="wing wing-l">
      <path d="M78,178 C52,168 38,182 30,202 C44,200 50,204 46,212 C58,208 66,210 64,218 C74,210 82,196 80,182 Z"
            fill="#fdeef5" stroke="#e9c2d6" stroke-width="1.5"/>
      <path d="M74,186 C60,182 50,190 46,200" fill="none" stroke="#eec3d8" stroke-width="1.2"/>
    </g>
    <g class="wing wing-r">
      <path d="M142,178 C168,168 182,182 190,202 C176,200 170,204 174,212 C162,208 154,210 156,218 C146,210 138,196 140,182 Z"
            fill="#fdeef5" stroke="#e9c2d6" stroke-width="1.5"/>
      <path d="M146,186 C160,182 170,190 174,200" fill="none" stroke="#eec3d8" stroke-width="1.2"/>
    </g>

    <!-- 腿与靴子 -->
    <rect x="95" y="228" width="13" height="16" rx="5" fill="#fdf9ff"/>
    <rect x="112" y="228" width="13" height="16" rx="5" fill="#fdf9ff"/>
    <path d="M92,240 h19 a5,7 0 0 1 5,7 v3 a3,3 0 0 1 -3,3 h-23 a3,3 0 0 1 -3,-3 v-5 a5,5 0 0 1 5,-5 Z" fill="#5a4a66"/>
    <path d="M109,240 h19 a5,5 0 0 1 5,5 v5 a3,3 0 0 1 -3,3 h-23 a3,3 0 0 1 -3,-3 v-3 a5,7 0 0 1 5,-7 Z" fill="#5a4a66"/>

    <!-- 连衣裙 -->
    <path d="M93,176 C90,204 80,222 72,238 L148,238 C140,222 130,204 127,176 Z"
          fill="url(#dressGrad)" stroke="#d5c9e2" stroke-width="1.5"/>
    <path d="M72,238 C90,231 130,231 148,238 L148,232 C130,225 90,225 72,232 Z" fill="#6b5b7b"/>
    <path d="M97,196 l6,6 -6,6 -6,-6 Z" fill="#f2a0bf"/>
    <path d="M123,196 l6,6 -6,6 -6,-6 Z" fill="#f2a0bf"/>

    <!-- 手臂 -->
    <path d="M93,180 C82,188 76,198 74,208" stroke="#f6f3f9" stroke-width="10" stroke-linecap="round" fill="none"/>
    <path d="M127,180 C138,188 144,198 146,208" stroke="#f6f3f9" stroke-width="10" stroke-linecap="round" fill="none"/>
    <circle cx="74" cy="210" r="5.5" fill="#ffeade"/>
    <circle cx="146" cy="210" r="5.5" fill="#ffeade"/>

    <!-- 脖颈与宝石项圈 -->
    <rect x="103" y="164" width="14" height="10" rx="4" fill="#ffeade"/>
    <path d="M100,170 q10,7 20,0" stroke="#4b3a55" stroke-width="4" fill="none"/>
    <circle cx="110" cy="176" r="4" fill="#e87ba5" stroke="#c2557f" stroke-width="1"/>

    <!-- 脑后头发 -->
    <ellipse cx="110" cy="118" rx="56" ry="54" fill="#e585ab"/>

    <!-- 脸 -->
    <circle cx="110" cy="120" r="44" fill="#ffeade"/>

    <!-- 侧边长发 -->
    <path d="M68,102 C62,124 62,146 68,166 C74,160 78,152 78,138 C78,124 76,110 74,102 Z" fill="url(#hairGrad)"/>
    <path d="M152,102 C158,124 158,146 152,166 C146,160 142,152 142,138 C142,124 144,110 146,102 Z" fill="url(#hairGrad)"/>

    <!-- 眉毛 -->
    <path d="M83,110 q8,-5 16,-1" stroke="#d98aa8" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M121,109 q8,-4 16,1" stroke="#d98aa8" stroke-width="2" fill="none" stroke-linecap="round"/>

    <!-- 眼睛（睁开） -->
    <g class="eyes-open">
      <g>
        <ellipse cx="91" cy="124" rx="7.5" ry="10.5" fill="#d46a8e"/>
        <ellipse cx="91" cy="127" rx="5" ry="6.5" fill="#b24a72"/>
        <circle cx="88.5" cy="119.5" r="2.6" fill="#fff"/>
        <circle cx="93.5" cy="128.5" r="1.3" fill="#ffb9d2"/>
      </g>
      <g>
        <ellipse cx="129" cy="124" rx="7.5" ry="10.5" fill="#d46a8e"/>
        <ellipse cx="129" cy="127" rx="5" ry="6.5" fill="#b24a72"/>
        <circle cx="126.5" cy="119.5" r="2.6" fill="#fff"/>
        <circle cx="131.5" cy="128.5" r="1.3" fill="#ffb9d2"/>
      </g>
    </g>
    <!-- 眼睛（眯眼笑： happy） -->
    <g class="eyes-happy">
      <path d="M83,126 q8,-9 16,0" stroke="#b24a72" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M121,126 q8,-9 16,0" stroke="#b24a72" stroke-width="3" fill="none" stroke-linecap="round"/>
    </g>
    <!-- 眼睛（困： sleepy） -->
    <g class="eyes-sleepy">
      <path d="M83,122 q8,7 16,0" stroke="#b24a72" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M121,122 q8,7 16,0" stroke="#b24a72" stroke-width="3" fill="none" stroke-linecap="round"/>
    </g>

    <!-- 嘴巴（按表情切换） -->
    <path id="mouth-smile" d="M103,146 q7,5 14,0" stroke="#c2607f" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path id="mouth-happy" d="M100,144 q10,13 20,0 q-10,5 -20,0 Z" fill="#c2607f"/>
    <ellipse id="mouth-surprised" cx="110" cy="148" rx="5" ry="6.5" fill="#c2607f"/>
    <path id="mouth-sleepy" d="M104,147 q3,2.5 6,0 q3,-2.5 6,0" stroke="#c2607f" stroke-width="2.2" fill="none" stroke-linecap="round"/>

    <!-- 腮红 -->
    <g id="blush">
      <ellipse cx="82" cy="139" rx="9" ry="4.5" fill="#ffb3c7"/>
      <ellipse cx="138" cy="139" rx="9" ry="4.5" fill="#ffb3c7"/>
    </g>

    <!-- 刘海 -->
    <path d="M66,108 C66,82 84,64 110,64 C136,64 154,82 154,108 C149,100 143,95 136,99 C131,88 119,86 111,93 C103,86 92,89 88,99 C80,95 71,99 66,108 Z"
          fill="url(#hairGrad)"/>

    <!-- 檐帽（压低帽檐，微斜） -->
    <g transform="rotate(-6 110 76)">
      <path d="M82,74 C82,48 94,36 110,36 C126,36 138,48 138,74 Z" fill="#4b3a55"/>
      <path d="M88,52 C94,44 100,41 110,40" stroke="#5d4a6a" stroke-width="3" fill="none" stroke-linecap="round"/>
      <ellipse cx="110" cy="78" rx="57" ry="13" fill="#43334d"/>
      <ellipse cx="110" cy="76" rx="57" ry="13" fill="#4b3a55"/>
      <path d="M53,76 a57,13 0 0 0 114,0 a57,13 0 0 1 -114,0 Z" fill="#3a2c44" opacity="0.55"/>
      <rect x="81" y="64" width="58" height="10" rx="4" fill="#f2a0bf"/>
      <!-- 帽带上的一根小羽毛（羽希人） -->
      <path d="M136,66 C144,58 152,56 158,58 C154,64 148,69 140,70 Z" fill="#fdeef5" stroke="#e9c2d6" stroke-width="1.2"/>
      <path d="M139,66 C145,62 150,60 154,59" stroke="#e9c2d6" stroke-width="1" fill="none"/>
    </g>
  </g>
</svg>`;

  window.RemielleCharacter = {
    mount(container) {
      container.innerHTML = SVG;
      return document.getElementById('chara');
    },
  };
})();
