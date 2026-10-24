import {ServiceUnavailableException} from '@nestjs/common';

/** One optional storage check runs at a time; failed checks never hold the Catalog listener. */
export class SourceUploadAvailability{
 private usable=false;
 private stopped=false;
 private generation=0;
 private timer?:ReturnType<typeof setTimeout>;
 private pending?:Promise<void>;
 constructor(private readonly initialize:()=>Promise<void>){}
 get ready():boolean{return this.usable&&!this.stopped;}
 assertReady():void{if(!this.ready)throw new ServiceUnavailableException('Хранилище исходников временно недоступно. История и отмена сохранены; проверьте хранилище и повторите загрузку.');}
 start():void{
  if(this.stopped||this.pending)return;
  if(this.timer)clearTimeout(this.timer);this.timer=undefined;
  const generation=this.generation;
  this.pending=Promise.resolve().then(this.initialize).then(()=>{if(!this.stopped&&generation===this.generation)this.usable=true;},()=>{this.usable=false;}).finally(()=>{
   this.pending=undefined;
   if(!this.stopped){this.timer=setTimeout(()=>{this.timer=undefined;this.start();},this.usable?60000:30000);this.timer.unref();}
  });
 }
 /** A durable cancellation can defer only its file removal; a later check retries the same tombstone. */
 unavailable():void{this.usable=false;this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(!this.stopped&&!this.pending){this.timer=setTimeout(()=>{this.timer=undefined;this.start();},30000);this.timer.unref();}}
 async close():Promise<void>{this.stopped=true;this.usable=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;await this.pending;}
}
