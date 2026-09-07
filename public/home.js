"use strict";
lucide.createIcons();
(() => {
  const canvas = document.querySelector("#protocol-flow");
  const scene = document.querySelector(".protocol-scene");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const toggle = document.querySelector("#motion-toggle");
  let paused = false, visible = true, active = null, frame = 0, previous = 0, elapsed = 0;
  let width = 0, height = 0, routes = [], core;
  const point = (r, t) => {
    const u = 1 - t;
    return { x: u*u*u*r[0] + 3*u*u*t*r[2] + 3*u*t*t*r[4] + t*t*t*r[6], y: u*u*u*r[1] + 3*u*u*t*r[3] + 3*u*t*t*r[5] + t*t*t*r[7] };
  };
  function measure() {
    const box = scene.getBoundingClientRect(), label = scene.querySelector(".protocol-core").getBoundingClientRect();
    width = box.width; height = box.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const compact = width < 600, coreWidth = compact ? Math.min(90, label.width - 6) : Math.min(265, label.width - 64);
    core = { x: width / 2 + (compact ? 7 : 0), y: label.top - box.top + label.height / 2, w: Math.max(65, coreWidth), h: compact ? 176 : 130 };
    routes = [...scene.querySelectorAll("[data-route]")].map(el => {
      const b = el.getBoundingClientRect(), input = el.dataset.route.startsWith("in");
      const x1 = input ? b.right-box.left : core.x+core.w/2, y1 = input ? b.top-box.top+b.height/2 : core.y;
      const x2 = input ? core.x-core.w/2 : b.left-box.left, y2 = input ? core.y : b.top-box.top+b.height/2;
      const gap = Math.max(0, x2-x1);
      return { id: el.dataset.route, curve: [x1,y1,x1+gap*.53,y1,x2-gap*.48,y2,x2,y2], input };
    });
    draw();
  }
  function draw() {
    if (!core) return;
    ctx.clearRect(0,0,width,height);
    // Sparse technical grid and directional paths remain visible without animation.
    ctx.fillStyle = "#dce9f3";
    for (let x=14;x<width;x+=24) for(let y=18;y<height-28;y+=24){ctx.beginPath();ctx.arc(x,y,.65,0,Math.PI*2);ctx.fill();}
    for (const [i, route] of routes.entries()) {
      const r=route.curve, highlighted=active===route.id;
      ctx.beginPath();ctx.moveTo(r[0],r[1]);ctx.bezierCurveTo(...r.slice(2));
      ctx.lineWidth=highlighted?2:1;ctx.strokeStyle=highlighted?"#4da3ff":"#c9dff1";ctx.stroke();
      for(let n=0;n<3;n++){
        const t=((elapsed*.00011+n/3+i*.107)%1), p=point(r,t);
        ctx.beginPath();ctx.arc(p.x,p.y,highlighted?2.5:1.7,0,Math.PI*2);ctx.fillStyle=highlighted?"#1e7bff":"#8bcbff";ctx.fill();
      }
    }
    const {x,y,w,h}=core;
    const left=x-w/2,right=x+w/2;
    ctx.beginPath();ctx.moveTo(left,y-h/2);ctx.bezierCurveTo(left+w*.19,y-h/2+12,left+w*.25,y-h/2+12,x,y-h/2+12);ctx.bezierCurveTo(right-w*.25,y-h/2+12,right-w*.19,y-h/2,right,y-h/2);ctx.lineTo(right,y+h/2);ctx.bezierCurveTo(right-w*.19,y+h/2-12,right-w*.25,y+h/2-12,x,y+h/2-12);ctx.bezierCurveTo(left+w*.25,y+h/2-12,left+w*.19,y+h/2,left,y+h/2);ctx.closePath();
    ctx.shadowColor="#66b7ff";ctx.shadowBlur=paused?10:14+Math.sin(elapsed*.0012)*4;ctx.fillStyle="#fafdff";ctx.fill();ctx.shadowBlur=0;ctx.lineWidth=1;ctx.strokeStyle="#b8d8f2";ctx.stroke();
    ctx.strokeStyle="#d7e9f7";ctx.beginPath();ctx.moveTo(left+5,y-h/2+6);ctx.lineTo(left+5,y+h/2-6);ctx.moveTo(right-5,y-h/2+6);ctx.lineTo(right-5,y+h/2-6);ctx.stroke();
    for(let n=0;n<4;n++){const t=(elapsed*.00008+n/4)%1;ctx.fillStyle="#6bb6f7";ctx.fillRect(left+10+t*Math.max(0,w-22),y-h/2+8,3,2);}
  }
  function tick(time){frame=0;if(paused||!visible||document.hidden){previous=0;return;}elapsed+=previous?Math.min(time-previous,50):0;previous=time;draw();frame=requestAnimationFrame(tick);}
  function schedule(){if(!frame&&!paused&&visible&&!document.hidden)frame=requestAnimationFrame(tick);}
  function button(){toggle.setAttribute("aria-label",paused?"Play animation":"Pause animation");toggle.title=paused?"Play animation":"Pause animation";toggle.innerHTML=paused?'<i data-lucide="play"></i>':'<i data-lucide="pause"></i>';lucide.createIcons();}
  toggle.addEventListener("click",()=>{paused=!paused;previous=0;button();draw();schedule();});
  for(const el of scene.querySelectorAll("[data-route]")){const highlight=()=>{active=el.dataset.route;draw();};const clear=()=>{active=null;draw();};el.addEventListener("mouseenter",highlight);el.addEventListener("focus",highlight);el.addEventListener("mouseleave",clear);el.addEventListener("blur",clear);}
  new ResizeObserver(measure).observe(scene);
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;previous=0;schedule();}).observe(scene);
  document.addEventListener("visibilitychange",()=>{previous=0;schedule();});
  button();measure();schedule();
})();
