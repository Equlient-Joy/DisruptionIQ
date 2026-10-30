export async function extractDocument(file: File): Promise<{filename:string;text:string;source:string}> {
  if(file.size>8*1024*1024) throw new Error('Documents must be smaller than 8 MB.');
  const filename=file.name;
  if(filename.toLowerCase().endsWith('.pdf')) {
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true} as any);
    const pdf=await task.promise;
    try {
      if(pdf.numPages>20) throw new Error('Documents must contain at most 20 pages.');
      const pages:string[]=[];
      for(let i=1;i<=pdf.numPages;i++) {
        const page=await pdf.getPage(i); const content=await page.getTextContent();
        pages.push(content.items.map(item=>'str' in item?item.str:'').join(' '));
      }
      return {filename,text:pages.join('\n'),source:'PDF text extraction'};
    } finally {await pdf.destroy();}
  }
  if(!/\.(txt|csv|json)$/i.test(filename)) throw new Error('Upload a text PDF, TXT, CSV or JSON document. Scanned PDF fields require manual review.');
  return {filename,text:await file.text(),source:'Text document parsing'};
}
