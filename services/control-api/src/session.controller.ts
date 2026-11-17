import { Controller, Get, Header, Headers, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";

@Controller("v1/session")
@SetMetadata(PUBLIC_ROUTE,true)
export class SessionController{
  constructor(private readonly auth:AuthService){}

  @Get()
  @Header("Cache-Control","no-store")
  async session(@Headers("authorization")authorization?:string){
    if(!authorization?.startsWith("Bearer "))throw new UnauthorizedException("Bearer token is required");
    return this.auth.discover(authorization.slice(7));
  }
}
