/** The confirmed fiscal year starts September 1 at 00:00 in Asia/Shanghai. */
export const financeYearBounds=(at:Date):Readonly<{start:string;end:string}>=>{
  if(!Number.isFinite(at.getTime()))throw new Error('INVALID_INPUT');
  const local=new Date(at.getTime()+8*60*60*1000);
  const year=local.getUTCFullYear()-(local.getUTCMonth()<8?1:0);
  return {start:new Date(Date.UTC(year,8,1)-8*60*60*1000).toISOString(),end:new Date(Date.UTC(year+1,8,1)-8*60*60*1000).toISOString()};
};
