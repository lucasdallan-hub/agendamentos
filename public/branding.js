// Branding is public; customer payment pages never fetch administrative data.
(async()=>{
 try{
  const response=await fetch('/api/system/branding');if(!response.ok)return;
  const brand=await response.json();
  document.title=document.title.split(' · ')[0]+' · '+brand.name;
  const target=document.querySelector('[data-public-brand]');if(!target)return;
  target.replaceChildren();
  if(brand.logo){const img=document.createElement('img');img.src=brand.logo;img.alt='Logo de '+brand.name;img.className='system-logo';target.append(img);}
  const name=document.createElement('span');name.textContent=brand.name;target.append(name);
 }catch{/* Payment availability does not depend on a branding request. */}
})();
