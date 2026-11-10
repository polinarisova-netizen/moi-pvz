import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const config=window.PVZ_FIREBASE_CONFIG;
let auth,db,owner=null,ready=false,connecting=false,writeTimer=null,queueData=null,watch=null,lastRemote=null;
const usable=Boolean(config?.apiKey&&config?.projectId&&config?.appId);
const signal=(connected)=>window.dispatchEvent(new CustomEvent('pvz-cloud-state',{detail:{connected,configured:usable}}));
const message=(s)=>{const x=document.getElementById('subtitle');if(x)x.textContent=s;};
const canonical=data=>JSON.parse(JSON.stringify(data));
const publicSchedule=(d,id)=>{
 const loc=d.locations.find(l=>l.id===id);if(!loc)return null;
 // Публикуем только имена и смены. Ставки, выплаты и закрытые данные не передаём.
 // Ключи года/месяца позволяют хранить историю в ОДНОМ документе на каждый ПВЗ,
 // поэтому существующие правила безопасности Firestore менять не нужно.
 const emps=d.employees.filter(e=>e.locations?.includes(id)).map(e=>({id:String(e.id),name:String(e.name)}));
 const shifts={};
 for(const e of emps){
  const prefix=id+'|'+e.id+'|';
  for(const [key,val] of Object.entries(d.shifts||{})){
   if(!key.startsWith(prefix))continue;
   const tail=key.slice(prefix.length).split('|');
   if(tail.length!==3)continue;
   const [y,m,day]=tail.map(Number);
   const amount=Number(val);
   if(!Number.isInteger(y)||y<2020||y>2100||!Number.isInteger(m)||m<0||m>11||!Number.isInteger(day)||day<1||day>new Date(y,m+1,0).getDate())continue;
   if(amount===1||amount===0.5)shifts[y+'|'+m+'|'+e.id+'|'+day]=amount;
  }
 }
 return {year:Number(d.year),month:Number(d.month),name:String(loc.name),employees:emps,shifts,updatedAt:serverTimestamp()};
};
let writing=false;
async function flush(){if(!ready||!queueData||writing)return;writing=true;const snapshot=queueData;queueData=null;
 try{
   const payload=canonical(snapshot);
   // Write public projections first; no employee salary ever included in these documents.
   for(const loc of payload.locations){const pub=publicSchedule(payload,loc.id);if(pub&&['glavnaya','popova'].includes(loc.id))await setDoc(doc(db,'pvzPublic',loc.id),pub);}
   await setDoc(doc(db,'pvzPrivate','admin'),{payload,updatedAt:serverTimestamp()});
   message('☁ Сохранено в облаке');
 }catch(error){message('⚠ Облачное сохранение не удалось');alert('Ошибка сохранения в облаке: '+error.message+'\nЛокальная резервная копия осталась на устройстве.');}
 finally{writing=false;if(queueData)writeTimer=setTimeout(flush,900)}
}
function queue(d){if(!ready)return;queueData=canonical(d);clearTimeout(writeTimer);writeTimer=setTimeout(flush,850);message('☁ Сохраняем изменения…');}
async function uploadLocal(data){ready=true;queue(data);signal(true);}
function markLoaded(data){ready=true;lastRemote=JSON.stringify(data);signal(true);queue(data);}
async function login(){if(!usable){alert('Облачная конфигурация отсутствует. Открой настройка.html.');return;}
 const layer=document.createElement('div');layer.style.cssText='position:fixed;inset:0;background:#0007;z-index:1000;display:grid;place-items:center;padding:18px';
 layer.innerHTML='<form style="width:min(420px,100%);background:white;border-radius:17px;padding:25px;display:grid;gap:13px;box-shadow:0 20px 60px #0004"><h2>Вход управляющей</h2><label>Электронная почта<input type="email" required autocomplete="username" style="display:block;width:100%;margin-top:5px" name="mail"></label><label>Пароль<input type="password" required autocomplete="current-password" style="display:block;width:100%;margin-top:5px" name="pass"></label><div style="display:flex;gap:10px"><button class="primary" type="submit">Войти в облако</button><button type="button" id="cancelCloud">Отмена</button></div><small id="loginError" style="color:#a33"></small></form>';
 document.body.appendChild(layer);layer.querySelector('#cancelCloud').onclick=()=>layer.remove();
 layer.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.target;const email=form.elements.mail.value.trim(),password=form.elements.pass.value;
  const error=layer.querySelector('#loginError');error.textContent='Проверяем…';
  try{await signInWithEmailAndPassword(auth,email,password);layer.remove()}catch(err){error.textContent='Войти не удалось: '+err.message;form.elements.pass.value='';}
 };
}
async function logout(){ready=false;queueData=null;clearTimeout(writeTimer);if(watch){watch();watch=null;}await signOut(auth);signal(false);message('Данные сохранены только на этом устройстве')}
window.pvzCloud={configured:usable,isConnected:()=>ready,queue,login,logout,uploadLocal,markLoaded};
signal(false);
if(usable){
 try{
  const app=initializeApp(config);auth=getAuth(app);db=getFirestore(app);
  onAuthStateChanged(auth,async user=>{
   if(!user){ready=false;signal(false);return;}
   if(connecting)return;connecting=true;owner=user.uid;message('☁ Проверяем облако…');
   try{
    const privateRef=doc(db,'pvzPrivate','admin'),snap=await getDoc(privateRef);
    if(snap.exists()&&snap.data().payload){const remote=snap.data().payload;
      const local=JSON.parse(localStorage.getItem('moi-pvz-v1')||'null');
      const populated=local&&(local.employees?.length||Object.keys(local.shifts||{}).length);
      if(populated&&JSON.stringify(local)!==JSON.stringify(remote))window.dispatchEvent(new CustomEvent('pvz-cloud-merge-request',{detail:remote}));
      else {window.dispatchEvent(new CustomEvent('pvz-cloud-restore',{detail:remote}));markLoaded(remote);}
    }else{
      const local=JSON.parse(localStorage.getItem('moi-pvz-v1')||'null');
      if(!local){ready=true;signal(true);message('☁ Подключено. Добавь сотрудников и смены.');}
      else if(confirm('В облаке пока нет графика. Опубликовать твой текущий график?'))uploadLocal(local);
      else{ready=true;signal(true)}
    }
   }catch(error){ready=false;alert('Ошибка доступа к Firebase. Проверь правила Firestore и адрес почты управляющей.\n'+error.message);signal(false)}
   connecting=false;
  });
 }catch(err){message('⚠ Ошибка настройки Firebase: '+err.message)}
}
