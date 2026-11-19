export function jpegDimensions(buffer){
 if(buffer.length<4||buffer[0]!==0xff||buffer[1]!==0xd8||buffer[buffer.length-2]!==0xff||buffer[buffer.length-1]!==0xd9)return null;
 for(let offset=2;offset+4<buffer.length;){
  if(buffer[offset]!==0xff)break;
  while(buffer[offset]===0xff)offset++;
  const marker=buffer[offset++];
  if(marker===0xda||marker===0xd9)break;
  if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
  if(offset+2>buffer.length)break;
  const length=buffer.readUInt16BE(offset);
  if(length<2||offset+length>buffer.length)break;
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
   if(length<8)break;
   return {height:buffer.readUInt16BE(offset+3),width:buffer.readUInt16BE(offset+5)};
  }
  offset+=length;
 }
 return null;
}
