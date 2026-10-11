// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/ChanceryRegistry.sol";
interface ForkSafe {
 function setup(address[] calldata,uint256,address,bytes calldata,address,address,uint256,address payable) external;
 function enableModule(address) external;
 function execTransaction(address,uint256,bytes calldata,uint8,uint256,uint256,uint256,address,address payable,bytes calldata) external payable returns(bool);
}
interface ForkFactory {function createProxyWithNonce(address,bytes calldata,uint256) external returns(address);}
interface ForkModule is IAllowanceModule {
 function addDelegate(address) external;
 function setAllowance(address,address,uint96,uint16,uint32) external;
 function removeDelegate(address,bool) external;
}
contract MainnetForkTest is Test {
 address constant TOKEN=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
 address constant MODULE=0xAA46724893dedD72658219405185Fb0Fc91e091C;
 address constant SINGLETON=0x41675C099F32341bf84BFc5382aF534df5C7461a;
 address constant FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
 bool enabled;ForkSafe safe;ChanceryRegistry registry;SettlementDelegate delegate;bytes32 office;uint32 period;
 address operator=address(0x12345);address treasury=address(0x98765);
 function setUp() public {
  enabled=vm.envOr("RHC_FORK",false);if(!enabled)return;
  vm.createSelectFork(vm.envOr("RHC_RPC_URL",string("https://rpc.mainnet.chain.robinhood.com")));
  assertEq(block.chainid,4663);
  assertEq(MODULE.codehash,hex"7aa63affdca06fe94576f00077ad61a02ccf203a5da31e1b4ed595df7b65cf3e");
  address[] memory owners=new address[](1);owners[0]=address(this);
  safe=ForkSafe(ForkFactory(FACTORY).createProxyWithNonce(SINGLETON,abi.encodeCall(ForkSafe.setup,(owners,1,address(0),bytes(""),address(0),address(0),0,payable(address(0)))),123456));
  registry=new ChanceryRegistry(TOKEN,treasury,MODULE,address(this),operator);
  address predicted=registry.delegateAddress(address(safe),bytes32(0));
  execute(address(safe),abi.encodeCall(ForkSafe.enableModule,(MODULE)));
  execute(MODULE,abi.encodeCall(ForkModule.addDelegate,(predicted)));
  execute(MODULE,abi.encodeCall(ForkModule.setAllowance,(predicted,TOKEN,100e6,43200,0)));
  execute(address(registry),abi.encodeCall(ChanceryRegistry.open,(bytes32(uint256(1)),bytes32(uint256(2)),100e6)));
  office=registry.officeIdFor(address(safe));delegate=SettlementDelegate(predicted);(,,period)=registry.budget(office);
  deal(TOKEN,address(safe),1000e6);
 }
 function execute(address to,bytes memory data) internal {
  bytes memory sig=abi.encodePacked(bytes32(uint256(uint160(address(this)))),bytes32(0),uint8(1));
  require(safe.execTransaction(to,0,data,0,0,0,0,address(0),payable(address(0)),sig),"Safe failed");
 }
 function pay(uint256 batch,uint96 amount) internal {vm.prank(operator);delegate.settle(bytes32(batch),uint64(block.timestamp/1 days),period,keccak256(abi.encode(batch)),1,amount);}
 function testForkCanonicalAllowanceTransferAndLog() public {
  if(!enabled){vm.skip(true);return;}
  uint256 beforeBalance=IERC20Balance(TOKEN).balanceOf(treasury);pay(1,7e6);
  assertEq(IERC20Balance(TOKEN).balanceOf(treasury),beforeBalance+7e6);
  uint256[5] memory a=ForkModule(MODULE).getTokenAllowance(address(safe),address(delegate),TOKEN);assertEq(a[1],7e6);assertEq(a[3],period);
  assertTrue(registry.settlementLog().recorded(keccak256(abi.encode(office,bytes32(0),bytes32(uint256(1))))));
  vm.expectRevert("duplicate batch");pay(1,7e6);
 }
 function testForkResetAndRemoval() public {
  if(!enabled){vm.skip(true);return;}
  pay(1,100e6);vm.warp(block.timestamp+30 days);period+=43200;pay(2,1e6);
  execute(MODULE,abi.encodeCall(ForkModule.removeDelegate,(address(delegate),true)));
  vm.expectRevert();pay(3,1);
 }
}
